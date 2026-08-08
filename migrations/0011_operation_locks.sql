CREATE TABLE operation_locks (
  scope TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  lock_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, resource_id)
);

INSERT INTO operation_locks (scope, resource_id, lock_id, acquired_at, expires_at)
SELECT 'player.assets', player_id, lock_id, acquired_at, expires_at
FROM checkout_locks;

DROP TABLE checkout_locks;

CREATE INDEX idx_operation_locks_expires_at ON operation_locks(expires_at);
