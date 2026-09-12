-- Preserve every existing row in the legacy shop. Run with all old writers stopped.

CREATE TABLE staff_users__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'viewer')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, id),
    UNIQUE (shop_id, username)
  );

CREATE TABLE admin_sessions__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    staff_user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    FOREIGN KEY (shop_id, staff_user_id) REFERENCES staff_users__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id),
    UNIQUE (shop_id, token_hash)
  );

CREATE TABLE api_tokens__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('integration', 'machine')),
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    PRIMARY KEY (shop_id, id),
    UNIQUE (shop_id, token_hash)
  );

CREATE TABLE app_settings__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, key)
  );

CREATE TABLE players__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'banned')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE player_identities__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    player_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, provider, subject),
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id)
  );

CREATE TABLE player_sessions__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id),
    UNIQUE (shop_id, token_hash)
  );

CREATE TABLE asset_definitions__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    type TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    stackable INTEGER NOT NULL DEFAULT 1 CHECK (stackable IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    pricing_effect_id TEXT,
    active_at TEXT,
    expires_at TEXT,
    metadata_json TEXT,
    PRIMARY KEY (shop_id, type, code),
    FOREIGN KEY (shop_id, pricing_effect_id) REFERENCES pricing_effects__tenant(shop_id, id)
  );

CREATE TABLE pricing_effects__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('free', 'discount', 'percentage-discount', 'surcharge')),
    scope TEXT NOT NULL CHECK (scope IN ('session', 'unified')),
    value REAL,
    consumable INTEGER NOT NULL DEFAULT 0 CHECK (consumable IN (0, 1)),
    limit_per_day INTEGER,
    active_at TEXT,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    config_json TEXT,
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE sessions__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    pricing_config_ids_json TEXT NOT NULL DEFAULT '[]',
    payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
    label TEXT,
    metadata_json TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE asset_holdings__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    asset_type TEXT NOT NULL,
    asset_code TEXT NOT NULL,
    quantity REAL NOT NULL,
    active_at TEXT,
    expires_at TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    FOREIGN KEY (shop_id, asset_type, asset_code) REFERENCES asset_definitions__tenant(shop_id, type, code),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE asset_transactions__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE asset_ledger_entries__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    transaction_id TEXT,
    asset_type TEXT NOT NULL,
    asset_code TEXT NOT NULL,
    delta REAL NOT NULL,
    reason TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    FOREIGN KEY (shop_id, transaction_id) REFERENCES asset_transactions__tenant(shop_id, id),
    FOREIGN KEY (shop_id, asset_type, asset_code) REFERENCES asset_definitions__tenant(shop_id, type, code),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE redeem_codes__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    code TEXT NOT NULL,
    present_id TEXT NOT NULL,
    active_at TEXT,
    expires_at TEXT,
    max_use_count INTEGER NOT NULL,
    PRIMARY KEY (shop_id, id),
    UNIQUE (shop_id, code)
  );

CREATE TABLE presents__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    once_per_player INTEGER NOT NULL DEFAULT 0 CHECK (once_per_player IN (0, 1)),
    active_at TEXT,
    expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    grants_json TEXT NOT NULL,
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE redeem_records__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    code_id TEXT NOT NULL,
    present_id TEXT NOT NULL,
    redeemed_at TEXT NOT NULL,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    FOREIGN KEY (shop_id, code_id) REFERENCES redeem_codes__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE device_commands__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('power.on', 'power.off', 'ac.set_temperature', 'coin', 'aime.scan', 'door.open')),
    device_id TEXT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('facility', 'game_machine')),
    executor_kind TEXT NOT NULL CHECK (executor_kind IN ('home_assistant', 'machine_ws', 'hinata_io', 'ttlock')),
    player_id TEXT,
    staff_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'acked', 'expired', 'rejected')),
    payload_json TEXT,
    requested_at TEXT NOT NULL,
    acked_at TEXT,
    expired_at TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE device_states__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    device_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('power.on', 'power.off', 'ac.set_temperature', 'coin', 'aime.scan', 'door.open')),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('facility', 'game_machine')),
    executor_kind TEXT NOT NULL CHECK (executor_kind IN ('home_assistant', 'machine_ws', 'hinata_io', 'ttlock')),
    label TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded')),
    state TEXT NOT NULL,
    metadata_json TEXT,
    reported_at TEXT NOT NULL,
    reported_by TEXT NOT NULL,
    PRIMARY KEY (shop_id, device_id)
  );

CREATE TABLE machine_connections__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    machine_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
    capabilities_json TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    disconnected_at TEXT,
    PRIMARY KEY (shop_id, machine_id)
  );

CREATE TABLE player_checkouts__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    subtotal REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('settled')),
    settled_at TEXT NOT NULL,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE settlements__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    checkout_id TEXT,
    subtotal REAL NOT NULL,
    total REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('settled')),
    settled_at TEXT NOT NULL,
    FOREIGN KEY (shop_id, session_id) REFERENCES sessions__tenant(shop_id, id),
    FOREIGN KEY (shop_id, checkout_id) REFERENCES player_checkouts__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id),
    UNIQUE (shop_id, session_id)
  );

CREATE TABLE settlement_charge_items__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    item_order INTEGER NOT NULL,
    source TEXT NOT NULL,
    label TEXT NOT NULL,
    amount REAL NOT NULL,
    PRIMARY KEY (shop_id, session_id, id),
    FOREIGN KEY (shop_id, session_id) REFERENCES sessions__tenant(shop_id, id)
  );

CREATE TABLE settlement_adjustments__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    adjustment_order INTEGER NOT NULL,
    source TEXT NOT NULL,
    label TEXT NOT NULL,
    amount REAL NOT NULL,
    PRIMARY KEY (shop_id, session_id, id),
    FOREIGN KEY (shop_id, session_id) REFERENCES sessions__tenant(shop_id, id)
  );

CREATE TABLE pricing_history_entries__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    pricing_config_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_anchor_at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE pricing_configs__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('time.priority', 'time.cap', 'charge.fixed')),
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    provider_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE pricing_cap_history_entries__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    cap_config_id TEXT NOT NULL,
    cap_rule_id TEXT NOT NULL,
    cap_anchor_at TEXT NOT NULL,
    included_pricing_config_ids_json TEXT NOT NULL,
    session_ids_json TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE business_items__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
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
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE business_item_orders__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
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
    FOREIGN KEY (shop_id, business_item_id) REFERENCES business_items__tenant(shop_id, id),
    FOREIGN KEY (shop_id, player_id) REFERENCES players__tenant(shop_id, id),
    FOREIGN KEY (shop_id, session_id) REFERENCES sessions__tenant(shop_id, id),
    PRIMARY KEY (shop_id, id)
  );

CREATE TABLE operation_locks__tenant (
    shop_id TEXT NOT NULL DEFAULT 'legacy',
    scope TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    lock_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (shop_id, scope, resource_id)
  );

INSERT INTO staff_users__tenant (shop_id, id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) SELECT 'legacy', id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at FROM staff_users;

INSERT INTO admin_sessions__tenant (shop_id, id, staff_user_id, token_hash, expires_at, created_at, last_used_at) SELECT 'legacy', id, staff_user_id, token_hash, expires_at, created_at, last_used_at FROM admin_sessions;

INSERT INTO api_tokens__tenant (shop_id, id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at) SELECT 'legacy', id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at FROM api_tokens;

INSERT INTO app_settings__tenant (shop_id, key, value_json, updated_at) SELECT 'legacy', key, value_json, updated_at FROM app_settings;

INSERT INTO players__tenant (shop_id, id, display_name, status, created_at) SELECT 'legacy', id, display_name, status, created_at FROM players;

INSERT INTO player_identities__tenant (shop_id, player_id, provider, subject, created_at) SELECT 'legacy', player_id, provider, subject, created_at FROM player_identities;

INSERT INTO player_sessions__tenant (shop_id, id, player_id, token_hash, expires_at, created_at, last_used_at, revoked_at) SELECT 'legacy', id, player_id, token_hash, expires_at, created_at, last_used_at, revoked_at FROM player_sessions;

INSERT INTO pricing_effects__tenant (shop_id, id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json) SELECT 'legacy', id, name, type, scope, value, consumable, limit_per_day, active_at, expires_at, status, config_json FROM pricing_effects;

INSERT INTO asset_definitions__tenant (shop_id, type, code, name, stackable, status, pricing_effect_id, active_at, expires_at, metadata_json) SELECT 'legacy', type, code, name, stackable, status, pricing_effect_id, active_at, expires_at, metadata_json FROM asset_definitions;

INSERT INTO sessions__tenant (shop_id, id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json) SELECT 'legacy', id, player_id, started_at, ended_at, status, pricing_config_ids_json, payment_status, label, metadata_json FROM sessions;

INSERT INTO asset_holdings__tenant (shop_id, id, player_id, asset_type, asset_code, quantity, active_at, expires_at) SELECT 'legacy', id, player_id, asset_type, asset_code, quantity, active_at, expires_at FROM asset_holdings;

INSERT INTO asset_transactions__tenant (shop_id, id, player_id, kind, ref_id, created_at, metadata_json) SELECT 'legacy', id, player_id, kind, ref_id, created_at, metadata_json FROM asset_transactions;

INSERT INTO asset_ledger_entries__tenant (shop_id, id, player_id, transaction_id, asset_type, asset_code, delta, reason, ref_id, created_at) SELECT 'legacy', id, player_id, transaction_id, asset_type, asset_code, delta, reason, ref_id, created_at FROM asset_ledger_entries;

INSERT INTO redeem_codes__tenant (shop_id, id, code, present_id, active_at, expires_at, max_use_count) SELECT 'legacy', id, code, present_id, active_at, expires_at, max_use_count FROM redeem_codes;

INSERT INTO presents__tenant (shop_id, id, name, once_per_player, active_at, expires_at, status, grants_json) SELECT 'legacy', id, name, once_per_player, active_at, expires_at, status, grants_json FROM presents;

INSERT INTO redeem_records__tenant (shop_id, id, player_id, code_id, present_id, redeemed_at) SELECT 'legacy', id, player_id, code_id, present_id, redeemed_at FROM redeem_records;

INSERT INTO device_commands__tenant (shop_id, id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at) SELECT 'legacy', id, type, device_id, target_kind, executor_kind, player_id, staff_id, status, payload_json, requested_at, acked_at, expired_at FROM device_commands;

INSERT INTO device_states__tenant (shop_id, device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by) SELECT 'legacy', device_id, type, target_kind, executor_kind, label, status, state, metadata_json, reported_at, reported_by FROM device_states;

INSERT INTO machine_connections__tenant (shop_id, machine_id, status, capabilities_json, connected_at, last_seen_at, disconnected_at) SELECT 'legacy', machine_id, status, capabilities_json, connected_at, last_seen_at, disconnected_at FROM machine_connections;

INSERT INTO player_checkouts__tenant (shop_id, id, player_id, subtotal, total, status, settled_at) SELECT 'legacy', id, player_id, subtotal, total, status, settled_at FROM player_checkouts;

INSERT INTO settlements__tenant (shop_id, id, session_id, checkout_id, subtotal, total, status, settled_at) SELECT 'legacy', id, session_id, checkout_id, subtotal, total, status, settled_at FROM settlements;

INSERT INTO settlement_charge_items__tenant (shop_id, id, session_id, item_order, source, label, amount) SELECT 'legacy', id, session_id, item_order, source, label, amount FROM settlement_charge_items;

INSERT INTO settlement_adjustments__tenant (shop_id, id, session_id, adjustment_order, source, label, amount) SELECT 'legacy', id, session_id, adjustment_order, source, label, amount FROM settlement_adjustments;

INSERT INTO pricing_history_entries__tenant (shop_id, id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at, session_id, amount, created_at, metadata_json) SELECT 'legacy', id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at, session_id, amount, created_at, metadata_json FROM pricing_history_entries;

INSERT INTO pricing_configs__tenant (shop_id, id, kind, name, enabled, status, provider_json, created_at, updated_at) SELECT 'legacy', id, kind, name, enabled, status, provider_json, created_at, updated_at FROM pricing_configs;

INSERT INTO pricing_cap_history_entries__tenant (shop_id, id, player_id, cap_config_id, cap_rule_id, cap_anchor_at, included_pricing_config_ids_json, session_ids_json, amount, created_at, metadata_json) SELECT 'legacy', id, player_id, cap_config_id, cap_rule_id, cap_anchor_at, included_pricing_config_ids_json, session_ids_json, amount, created_at, metadata_json FROM pricing_cap_history_entries;

INSERT INTO business_items__tenant (shop_id, id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at) SELECT 'legacy', id, kind, name, status, price, asset_type, asset_code, active_at, expires_at, metadata_json, created_at, updated_at FROM business_items;

INSERT INTO business_item_orders__tenant (shop_id, id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status, price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at) SELECT 'legacy', id, business_item_id, business_item_kind, business_item_name, player_id, session_id, status, price, asset_type, asset_code, metadata_json, created_at, updated_at, fulfilled_at, cancelled_at FROM business_item_orders;

INSERT INTO operation_locks__tenant (shop_id, scope, resource_id, lock_id, acquired_at, expires_at) SELECT 'legacy', scope, resource_id, lock_id, acquired_at, expires_at FROM operation_locks;

DROP TABLE operation_locks;

DROP TABLE business_item_orders;

DROP TABLE business_items;

DROP TABLE pricing_cap_history_entries;

DROP TABLE pricing_configs;

DROP TABLE pricing_history_entries;

DROP TABLE settlement_adjustments;

DROP TABLE settlement_charge_items;

DROP TABLE settlements;

DROP TABLE player_checkouts;

DROP TABLE machine_connections;

DROP TABLE device_states;

DROP TABLE device_commands;

DROP TABLE redeem_records;

DROP TABLE presents;

DROP TABLE redeem_codes;

DROP TABLE asset_ledger_entries;

DROP TABLE asset_transactions;

DROP TABLE asset_holdings;

DROP TABLE sessions;

DROP TABLE asset_definitions;

DROP TABLE pricing_effects;

DROP TABLE player_sessions;

DROP TABLE player_identities;

DROP TABLE players;

DROP TABLE app_settings;

DROP TABLE api_tokens;

DROP TABLE admin_sessions;

DROP TABLE staff_users;

ALTER TABLE staff_users__tenant RENAME TO staff_users;

ALTER TABLE admin_sessions__tenant RENAME TO admin_sessions;

ALTER TABLE api_tokens__tenant RENAME TO api_tokens;

ALTER TABLE app_settings__tenant RENAME TO app_settings;

ALTER TABLE players__tenant RENAME TO players;

ALTER TABLE player_identities__tenant RENAME TO player_identities;

ALTER TABLE player_sessions__tenant RENAME TO player_sessions;

ALTER TABLE asset_definitions__tenant RENAME TO asset_definitions;

ALTER TABLE pricing_effects__tenant RENAME TO pricing_effects;

ALTER TABLE sessions__tenant RENAME TO sessions;

ALTER TABLE asset_holdings__tenant RENAME TO asset_holdings;

ALTER TABLE asset_transactions__tenant RENAME TO asset_transactions;

ALTER TABLE asset_ledger_entries__tenant RENAME TO asset_ledger_entries;

ALTER TABLE redeem_codes__tenant RENAME TO redeem_codes;

ALTER TABLE presents__tenant RENAME TO presents;

ALTER TABLE redeem_records__tenant RENAME TO redeem_records;

ALTER TABLE device_commands__tenant RENAME TO device_commands;

ALTER TABLE device_states__tenant RENAME TO device_states;

ALTER TABLE machine_connections__tenant RENAME TO machine_connections;

ALTER TABLE player_checkouts__tenant RENAME TO player_checkouts;

ALTER TABLE settlements__tenant RENAME TO settlements;

ALTER TABLE settlement_charge_items__tenant RENAME TO settlement_charge_items;

ALTER TABLE settlement_adjustments__tenant RENAME TO settlement_adjustments;

ALTER TABLE pricing_history_entries__tenant RENAME TO pricing_history_entries;

ALTER TABLE pricing_configs__tenant RENAME TO pricing_configs;

ALTER TABLE pricing_cap_history_entries__tenant RENAME TO pricing_cap_history_entries;

ALTER TABLE business_items__tenant RENAME TO business_items;

ALTER TABLE business_item_orders__tenant RENAME TO business_item_orders;

ALTER TABLE operation_locks__tenant RENAME TO operation_locks;

CREATE INDEX IF NOT EXISTS idx_sessions_player_status ON sessions(shop_id, player_id, status);

CREATE INDEX IF NOT EXISTS idx_player_identities_player ON player_identities(shop_id, player_id);

CREATE INDEX IF NOT EXISTS idx_player_sessions_token ON player_sessions(shop_id, token_hash);

CREATE INDEX IF NOT EXISTS idx_asset_holdings_player ON asset_holdings(shop_id, player_id);

CREATE INDEX IF NOT EXISTS idx_asset_transactions_player_created ON asset_transactions(shop_id, player_id, created_at);

CREATE INDEX IF NOT EXISTS idx_asset_ledger_player_created ON asset_ledger_entries(shop_id, player_id, created_at);

CREATE INDEX IF NOT EXISTS idx_redeem_records_code ON redeem_records(shop_id, code_id);

CREATE INDEX IF NOT EXISTS idx_device_commands_status_requested ON device_commands(shop_id, status, requested_at);

CREATE INDEX IF NOT EXISTS idx_device_states_reported_at ON device_states(shop_id, reported_at);

CREATE INDEX IF NOT EXISTS idx_machine_connections_status_seen ON machine_connections(shop_id, status, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_player_checkouts_player_settled ON player_checkouts(shop_id, player_id, settled_at);

CREATE INDEX IF NOT EXISTS idx_settlements_checkout ON settlements(shop_id, checkout_id);

CREATE INDEX IF NOT EXISTS idx_pricing_configs_enabled_updated ON pricing_configs(shop_id, enabled, updated_at);

CREATE INDEX IF NOT EXISTS idx_business_items_status_updated ON business_items(shop_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_business_items_kind_status ON business_items(shop_id, kind, status);

CREATE INDEX IF NOT EXISTS idx_business_item_orders_player_created ON business_item_orders(shop_id, player_id, created_at);

CREATE INDEX IF NOT EXISTS idx_business_item_orders_item_status ON business_item_orders(shop_id, business_item_id, status);

CREATE INDEX IF NOT EXISTS idx_settlement_charge_items_session_order ON settlement_charge_items(shop_id, session_id, item_order);

CREATE INDEX IF NOT EXISTS idx_settlement_adjustments_session_order ON settlement_adjustments(shop_id, session_id, adjustment_order);

CREATE INDEX IF NOT EXISTS idx_pricing_history_player_rule_anchor ON pricing_history_entries(shop_id, player_id, pricing_config_id, provider_id, rule_id, rule_anchor_at);

CREATE INDEX IF NOT EXISTS idx_pricing_history_session ON pricing_history_entries(shop_id, session_id);

CREATE INDEX IF NOT EXISTS idx_pricing_cap_history_player_rule_anchor ON pricing_cap_history_entries(shop_id, player_id, cap_config_id, cap_rule_id, cap_anchor_at);

CREATE INDEX IF NOT EXISTS idx_staff_users_role_status ON staff_users(shop_id, role, status);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(shop_id, token_hash);

CREATE INDEX IF NOT EXISTS idx_api_tokens_role_status ON api_tokens(shop_id, role, status);

CREATE INDEX IF NOT EXISTS idx_operation_locks_expires_at ON operation_locks(shop_id, expires_at);
