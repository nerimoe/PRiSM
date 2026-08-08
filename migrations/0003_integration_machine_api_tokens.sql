PRAGMA foreign_keys = OFF;

CREATE TABLE api_tokens_next (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('integration', 'machine')),
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

INSERT INTO api_tokens_next (id, label, role, token_prefix, token_hash, status, created_at, last_used_at, revoked_at)
SELECT
  id,
  label,
  CASE role
    WHEN 'bot' THEN 'integration'
    WHEN 'agent' THEN 'machine'
    ELSE role
  END AS role,
  token_prefix,
  token_hash,
  status,
  created_at,
  last_used_at,
  revoked_at
FROM api_tokens
WHERE role IN ('bot', 'agent', 'integration', 'machine');

DROP TABLE api_tokens;
ALTER TABLE api_tokens_next RENAME TO api_tokens;

PRAGMA foreign_keys = ON;
