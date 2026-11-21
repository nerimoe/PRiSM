-- Coin becomes a capability of its own, apart from the HINATA IO that may press it.
--
-- A HINATA IO kept its coin in its own config: `coinKey` (0 for none; a config
-- saved without it coined with the default 32), and since named keys,
-- `keys` and `coinKeyId`, with `coinMethod`, `coinCap` and `coinAfterSwipe`.
-- Now the IO keeps its connection and its named keys, and a `coin` row says
-- how the resource takes a coin: `method` 'key' presses the IO key `keyId`,
-- with the limit (`cap`) and the coin after a swipe (`afterSwipe`).

-- A cabinet with a coin key but no named keys gets that key, named 投币.
UPDATE device_capabilities
SET config_json = json_set(config_json, '$.keys', json_array(json_object(
  'id', 'coin', 'name', '投币',
  'key', CASE WHEN json_type(config_json, '$.coinKey') IS NULL THEN 32 ELSE json_extract(config_json, '$.coinKey') END)))
WHERE capability = 'hinata_io'
  AND CASE WHEN json_type(config_json, '$.coinKey') IS NULL THEN 32 ELSE json_extract(config_json, '$.coinKey') END > 0
  AND COALESCE(json_array_length(json_extract(config_json, '$.keys')), 0) = 0;

-- Its coin presses the key it chose, or the key with the coin key's code.
INSERT OR IGNORE INTO device_capabilities
  (shop_id, device_id, capability, config_json, secret_json, credential_hash, created_at, updated_at)
SELECT shop_id, device_id, 'coin',
  json_object(
    'method', 'key',
    'keyId', COALESCE(
      json_extract(config_json, '$.coinKeyId'),
      (SELECT json_extract(k.value, '$.id') FROM json_each(json_extract(config_json, '$.keys')) k
        WHERE json_extract(k.value, '$.key') = CASE WHEN json_type(config_json, '$.coinKey') IS NULL THEN 32 ELSE json_extract(config_json, '$.coinKey') END
        LIMIT 1)),
    'cap', json_extract(config_json, '$.coinCap'),
    'afterSwipe', json(CASE WHEN json_extract(config_json, '$.coinAfterSwipe') THEN 'true' ELSE 'false' END)),
  '{}', NULL, updated_at, updated_at
FROM device_capabilities
WHERE capability = 'hinata_io'
  AND CASE WHEN json_type(config_json, '$.coinKey') IS NULL THEN 32 ELSE json_extract(config_json, '$.coinKey') END > 0;

-- The IO keeps only its connection and keys.
UPDATE device_capabilities
SET config_json = json_remove(config_json, '$.coinKey', '$.coinKeyId', '$.coinMethod', '$.coinCap', '$.coinAfterSwipe')
WHERE capability = 'hinata_io';
