-- Durable snapshots and staged imports keep transfer memory bounded by a page.
CREATE TABLE shop_data_jobs (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('export','import')), status TEXT NOT NULL,
 header_json TEXT NOT NULL, target_state TEXT, fingerprint TEXT, result_json TEXT, operation_id TEXT,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX shop_data_jobs_expiry ON shop_data_jobs(expires_at);
CREATE TABLE shop_data_rows (
 job_id TEXT NOT NULL REFERENCES shop_data_jobs(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, table_name TEXT NOT NULL, payload_json TEXT NOT NULL,
 PRIMARY KEY(job_id,seq)
);
CREATE INDEX shop_data_rows_table ON shop_data_rows(job_id,table_name,seq);
CREATE TABLE shop_data_parts (
 job_id TEXT NOT NULL REFERENCES shop_data_jobs(id) ON DELETE CASCADE,
 part INTEGER NOT NULL, request_hash TEXT NOT NULL, PRIMARY KEY(job_id,part)
);
CREATE TABLE shop_data_keys (
 job_id TEXT NOT NULL REFERENCES shop_data_jobs(id) ON DELETE CASCADE,
 table_name TEXT NOT NULL, key_kind INTEGER NOT NULL, key_json TEXT NOT NULL,
 PRIMARY KEY(job_id,table_name,key_kind,key_json)
);
CREATE TABLE shop_imported_accounts (
 shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
 source_user_id TEXT NOT NULL, player_id TEXT, staff_id TEXT, member_role TEXT,
 verified_at TEXT, identities_json TEXT NOT NULL, platform_bindings_json TEXT NOT NULL,
 matched_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 PRIMARY KEY(shop_id,source_user_id)
);

CREATE TABLE shop_data_device_ids (
 job_id TEXT NOT NULL REFERENCES shop_data_jobs(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL, id TEXT NOT NULL, public_id TEXT NOT NULL,
 PRIMARY KEY(job_id,source_id), UNIQUE(job_id,id), UNIQUE(job_id,public_id)
);
