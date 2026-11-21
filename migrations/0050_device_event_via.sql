-- An event says where it came into the platform: a scanned page, the merchant
-- board, a bot, the HTTP API, a HINATA IO's own channel, a Home Assistant
-- watcher, or a rule of the platform's own (`via`). When that way is one of the
-- shop's own resources, such as the bot a command was said to, the event names
-- it (`via_resource_id`) and belongs to that resource's history as well as its
-- device's.
--
-- Until now the only trace was `viaBot` inside the payload of a request a bot
-- asked for, which nothing could list by. Those requests and their results are
-- given their bot here; every other past event keeps NULL: where it came from
-- was never recorded, and guessing would be worse than not saying.
ALTER TABLE device_events ADD COLUMN via TEXT;
ALTER TABLE device_events ADD COLUMN via_resource_id TEXT;

UPDATE device_events
SET via = 'bot', via_resource_id = json_extract(payload_json, '$.viaBot')
WHERE kind = 'request' AND json_type(payload_json, '$.viaBot') = 'text';

-- A result carries its outcome, not what was asked: it takes its request's way.
UPDATE device_events
SET via = 'bot', via_resource_id = (
  SELECT r.via_resource_id FROM device_events r
  WHERE r.shop_id = device_events.shop_id AND r.operation_id = device_events.operation_id
    AND r.kind = 'request' AND r.via_resource_id IS NOT NULL
)
WHERE kind = 'result' AND operation_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM device_events r
  WHERE r.shop_id = device_events.shop_id AND r.operation_id = device_events.operation_id
    AND r.kind = 'request' AND r.via_resource_id IS NOT NULL
);

CREATE INDEX device_events_via ON device_events(shop_id, via_resource_id, occurred_at)
  WHERE via_resource_id IS NOT NULL;
