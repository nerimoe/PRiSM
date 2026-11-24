-- Unified shop-level edge nodes (`hinata_io`, `launcher`, `iot`).
--
-- Direct-connected HINATA IO credentials and relay channels previously lived
-- directly inside `device_capabilities` (`capability = 'hinata_io'`). Moving
-- edge-node identity, credentials, and Durable Object channels into `shop_nodes`
-- lets HINATA IO, PRiSM Launcher, and dedicated IoT hardware nodes share one
-- connection, heartbeat, config-push, and Home Assistant watcher lifecycle,
-- while resources bind to nodes by `nodeId` (supporting 1:0, 1:1, and 1:N).

CREATE TABLE IF NOT EXISTS shop_nodes (
  shop_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  channel TEXT NOT NULL,
  credential_hash TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id, id),
  UNIQUE (channel)
);

CREATE UNIQUE INDEX IF NOT EXISTS shop_nodes_credential
  ON shop_nodes(credential_hash) WHERE credential_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS shop_nodes_shop_kind
  ON shop_nodes(shop_id, kind);

-- Adopt existing direct-connected HINATA IO bindings as `hinata_io` nodes,
-- preserving both `channel` (Durable Object name) and `credential_hash` so
-- deployed IOs stay connected without re-provisioning.
INSERT OR IGNORE INTO shop_nodes
  (shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at)
SELECT
  c.shop_id,
  'io_' || c.device_id,
  'hinata_io',
  COALESCE((SELECT m.name FROM machines m WHERE m.shop_id = c.shop_id AND m.id = c.device_id), c.device_id),
  COALESCE((SELECT m.enabled FROM machines m WHERE m.shop_id = c.shop_id AND m.id = c.device_id), 1),
  json_extract(c.config_json, '$.channel'),
  c.credential_hash,
  json_object('haWatch', json('true')),
  c.created_at,
  c.updated_at
FROM device_capabilities c
WHERE c.capability = 'hinata_io'
  AND json_extract(c.config_json, '$.transport') = 'embedded'
  AND json_extract(c.config_json, '$.channel') IS NOT NULL
  AND json_extract(c.config_json, '$.channel') != '';

-- Point each embedded `hinata_io` capability at its node id while keeping
-- `channel` for read compatibility, and clear the duplicated credential hash
-- now owned by `shop_nodes`.
UPDATE device_capabilities
SET
  config_json = json_set(config_json, '$.nodeId', 'io_' || device_id),
  credential_hash = NULL
WHERE capability = 'hinata_io'
  AND json_extract(config_json, '$.transport') = 'embedded'
  AND json_extract(config_json, '$.channel') IS NOT NULL
  AND json_extract(config_json, '$.channel') != ''
  AND EXISTS (
    SELECT 1 FROM shop_nodes n
    WHERE n.shop_id = device_capabilities.shop_id
      AND n.id = 'io_' || device_capabilities.device_id
  );
