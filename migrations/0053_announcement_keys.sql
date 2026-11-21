-- A bot's rules and its own words now name what they announce by the event
-- itself (`announcementCatalog` in @prism/core): an attempt and how it went
-- (`power.on.sent`, `coin.refused`), or a fact (`card.consumed`). The old
-- names map onto them so every rule says what it said before:
--
-- - a machine seen switching on or off: `power.changed.on` / `.off`;
-- - a card a game took, someone starting on a resource: `card.consumed`,
--   `occupancy.started`;
-- - a request the hardware took: `<action>.sent`, the idle rule's power-off
--   `power.off.idle.sent`, and a coin both as asked and as added after a card;
-- - a request turned away: each device action's own `.refused`.
--
-- The map is a JSON object read with json_each, not a list of SELECTs joined
-- by UNION: D1 allows five terms in a compound SELECT.
UPDATE device_capabilities
SET config_json = json_set(config_json, '$.announceRules', (
  SELECT json_group_array(json_set(r.value, '$.events', (
    SELECT json_group_array(DISTINCT m.value)
    FROM json_each(r.value, '$.events') e
    JOIN json_each(json_extract(
      '{"power.on":["power.changed.on"],"power.off":["power.changed.off"],"card":["card.consumed"],"start":["occupancy.started"],"cabinet.coin":["cabinet.coin"],"cabinet.consumed":["cabinet.consumed"],"cabinet.reset":["cabinet.reset"],"request.power.on":["power.on.sent"],"request.power.off":["power.off.sent"],"request.power.idle_off":["power.off.idle.sent"],"request.card":["aime.scan.sent"],"request.coin":["coin.sent","coin.auto.sent"],"idle.reminder":["idle.reminder"],"platform.maintenance":["platform.maintenance"],"session.started":["session.started"],"session.stopped":["session.stopped"],"checkout.settled":["checkout.settled"],"checkout.refused":["checkout.refused"],"wallet.adjusted":["wallet.adjusted"],"gift.redeemed":["gift.redeemed"],"card.bound":["card.bound"],"request.refused":["power.on.refused","power.off.refused","power.keep.refused","aime.scan.refused","coin.refused"]}',
      '$."' || e.value || '"'
    )) m
  )))
  FROM json_each(device_capabilities.config_json, '$.announceRules') r
))
WHERE capability = 'bot' AND json_type(config_json, '$.announceRules') = 'array';

-- A shop's own words move with the names. A refusal's words named the action as
-- {action}, which each refusal now says itself, so those are let go.
UPDATE device_capabilities
SET config_json = json_set(config_json, '$.replyTemplates', (
  SELECT json_group_object(
    COALESCE(json_extract(
      '{"announce.power.on.message":"announce.power.changed.on.message","announce.power.off.message":"announce.power.changed.off.message","announce.card.message":"announce.card.consumed.message","announce.start.message":"announce.occupancy.started.message","announce.request.power.on.message":"announce.power.on.sent.message","announce.request.power.off.message":"announce.power.off.sent.message","announce.request.power.idle_off.message":"announce.power.off.idle.sent.message","announce.request.card.message":"announce.aime.scan.sent.message","announce.request.coin.message":"announce.coin.sent.message"}',
      '$."' || t.key || '"'
    ), t.key),
    t.value
  )
  FROM json_each(device_capabilities.config_json, '$.replyTemplates') t
  WHERE t.key <> 'announce.request.refused.message'
))
WHERE capability = 'bot' AND json_type(config_json, '$.replyTemplates') = 'object';
