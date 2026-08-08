CREATE TABLE IF NOT EXISTS player_checkouts (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  subtotal REAL NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('settled')),
  settled_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

ALTER TABLE settlements ADD COLUMN checkout_id TEXT REFERENCES player_checkouts(id);

INSERT INTO player_checkouts (id, player_id, subtotal, total, status, settled_at)
SELECT
  'legacy:' || s.player_id || ':' || st.settled_at,
  s.player_id,
  SUM(st.subtotal),
  MAX(0, SUM(st.total)),
  'settled',
  st.settled_at
FROM settlements st
INNER JOIN sessions s ON s.id = st.session_id
GROUP BY s.player_id, st.settled_at;

UPDATE settlements
SET checkout_id = (
  SELECT pc.id
  FROM player_checkouts pc
  INNER JOIN sessions s ON s.player_id = pc.player_id
  WHERE s.id = settlements.session_id
    AND pc.settled_at = settlements.settled_at
  LIMIT 1
)
WHERE checkout_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_player_checkouts_player_settled
ON player_checkouts(player_id, settled_at);

CREATE INDEX IF NOT EXISTS idx_settlements_checkout
ON settlements(checkout_id);
