-- The platform now tells the shops' bots ahead of a deployment and once it is
-- over (`platform.maintenance`, said where a bot's rules send it). A rule that
-- already passes on the idle power-off warning hears these too: it is the
-- other notice about the shop's machines stopping, and a shop should not have
-- to find the new type to hear that its service is about to pause.
UPDATE device_capabilities
SET config_json = json_set(config_json, '$.announceRules', (
  SELECT json_group_array(
    CASE
      WHEN EXISTS (SELECT 1 FROM json_each(r.value, '$.events') e WHERE e.value = 'idle.reminder')
        AND NOT EXISTS (SELECT 1 FROM json_each(r.value, '$.events') e WHERE e.value = 'platform.maintenance')
      THEN json_insert(r.value, '$.events[#]', 'platform.maintenance')
      ELSE json(r.value)
    END
  )
  FROM json_each(device_capabilities.config_json, '$.announceRules') r
))
WHERE capability = 'bot' AND json_type(config_json, '$.announceRules') = 'array';
