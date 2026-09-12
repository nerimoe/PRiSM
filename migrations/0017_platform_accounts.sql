-- Fresh platform tables. Existing ArcadeLink rows are imported separately, never reset.
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT,
  UNIQUE(provider, provider_subject),
  UNIQUE(user_id, provider)
);

CREATE TABLE bans (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subject_type, subject_value)
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  card_type TEXT NOT NULL DEFAULT 'aime',
  access_code TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, access_code)
);

CREATE TABLE machine_login_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
  machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
  ip TEXT,
  latitude REAL,
  longitude REAL,
  accuracy REAL,
  distance_meters REAL,
  risk_result TEXT NOT NULL,
  result TEXT NOT NULL,
  response_code INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hinata_url_encrypted TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, hinata_password_encrypted TEXT);

CREATE TABLE oauth_credentials (
  identity_id TEXT PRIMARY KEY REFERENCES auth_identities(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  last_cards_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT 'Passkey',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
, aaguid TEXT, provider_name TEXT);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shop_members (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id, user_id)
);

CREATE TABLE shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  radius_meters INTEGER NOT NULL DEFAULT 80,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, public_id TEXT, hero_data TEXT, hero_hash TEXT);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  banned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_auth_identities_user_id ON auth_identities(user_id);

CREATE INDEX idx_bans_subject ON bans(subject_type, subject_value);

CREATE INDEX idx_cards_user_id ON cards(user_id);

CREATE INDEX idx_machine_login_events_machine_id ON machine_login_events(machine_id);

CREATE INDEX idx_machine_login_events_user_id ON machine_login_events(user_id);

CREATE INDEX idx_machines_public_id ON machines(public_id);

CREATE INDEX idx_machines_shop_id ON machines(shop_id);

CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);

CREATE INDEX idx_sessions_token_hash ON auth_sessions(token_hash);

CREATE INDEX idx_sessions_user_id ON auth_sessions(user_id);

CREATE INDEX idx_shop_members_user_id ON shop_members(user_id);

CREATE UNIQUE INDEX idx_shops_public_id ON shops(public_id);

CREATE TABLE shop_billing_settings (
 shop_id TEXT PRIMARY KEY REFERENCES shops(id),
 billing_enabled INTEGER NOT NULL DEFAULT 0 CHECK(billing_enabled IN (0,1)),
 auto_register INTEGER NOT NULL DEFAULT 0 CHECK(auto_register IN (0,1)),
 checkin_geo INTEGER NOT NULL DEFAULT 0 CHECK(checkin_geo IN (0,1)),
 checkout_geo INTEGER NOT NULL DEFAULT 0 CHECK(checkout_geo IN (0,1)),
 machine_geo INTEGER NOT NULL DEFAULT 0 CHECK(machine_geo IN (0,1)),
 entry_pricing_ids_json TEXT NOT NULL DEFAULT '[]',
 bot_contact TEXT NOT NULL DEFAULT ''
);

CREATE TABLE shop_player_accounts (
 shop_id TEXT NOT NULL REFERENCES shops(id), user_id TEXT NOT NULL REFERENCES users(id),
 player_id TEXT NOT NULL, qq TEXT NOT NULL, verified_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,user_id), UNIQUE(shop_id,qq), UNIQUE(shop_id,player_id),
 FOREIGN KEY(shop_id,player_id) REFERENCES players(shop_id,id)
);

CREATE TABLE qq_binding_codes (
 shop_id TEXT NOT NULL REFERENCES shops(id), user_id TEXT NOT NULL REFERENCES users(id),
 code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(shop_id,user_id)
);

CREATE TABLE machine_tickets (
 token_hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
 expires_at TEXT NOT NULL, claimed_by TEXT REFERENCES users(id), claimed_at TEXT,
 operation_id TEXT UNIQUE
);

CREATE TABLE player_operations (
 shop_id TEXT NOT NULL REFERENCES shops(id), user_id TEXT NOT NULL REFERENCES users(id),
 id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','completed','failed','unknown')),
 request_hash TEXT NOT NULL DEFAULT '', result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY(shop_id,user_id,id)
);

CREATE TABLE shop_staff_accounts (
 shop_id TEXT NOT NULL REFERENCES shops(id), user_id TEXT NOT NULL REFERENCES users(id),
 staff_id TEXT NOT NULL, PRIMARY KEY(shop_id,user_id),
 FOREIGN KEY(shop_id,staff_id) REFERENCES staff_users(shop_id,id)
);
