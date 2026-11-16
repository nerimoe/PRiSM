-- A bot announces by one list of rules, each naming the events it listens for,
-- where they must have come from, and the destinations it says them at
-- (`announceRules`). A group and a person are the same kind of destination, and
-- the idle warning is an event like any other.
--
-- Until now a bot had one list of groups (`announceChannelIds`) for everything
-- it said, a list of what it said there (`announceEvents`), and five switches
-- from before that list, kept for plugins that read them. Those become the
-- bot's first rule: the same events, from anywhere, said in the same groups.
-- A bot with no groups, or that announced nothing, gets no rule: it said
-- nothing before and says nothing now.
UPDATE device_capabilities
SET config_json = json_remove(
  json_set(
    config_json,
    '$.announceRules',
    CASE
      WHEN json_type(config_json, '$.announceChannelIds') = 'array'
        AND json_array_length(config_json, '$.announceChannelIds') > 0
        AND json_array_length(
          CASE
            WHEN json_type(config_json, '$.announceEvents') = 'array' THEN json_extract(config_json, '$.announceEvents')
            ELSE (
              SELECT json_group_array(type) FROM (
                SELECT 'idle.reminder' AS type WHERE json_extract(device_capabilities.config_json, '$.announceIdle')
                UNION ALL SELECT 'power.on' WHERE json_extract(device_capabilities.config_json, '$.announcePower')
                UNION ALL SELECT 'power.off' WHERE json_extract(device_capabilities.config_json, '$.announcePower')
                UNION ALL SELECT 'start' WHERE json_extract(device_capabilities.config_json, '$.announceStarts')
                UNION ALL SELECT 'card' WHERE json_extract(device_capabilities.config_json, '$.announceCards')
                UNION ALL SELECT 'request.coin' WHERE json_extract(device_capabilities.config_json, '$.announceCoins')
              )
            )
          END
        ) > 0
      THEN json_array(json_object(
        'events', json(
          CASE
            WHEN json_type(config_json, '$.announceEvents') = 'array' THEN json_extract(config_json, '$.announceEvents')
            ELSE (
              SELECT json_group_array(type) FROM (
                SELECT 'idle.reminder' AS type WHERE json_extract(device_capabilities.config_json, '$.announceIdle')
                UNION ALL SELECT 'power.on' WHERE json_extract(device_capabilities.config_json, '$.announcePower')
                UNION ALL SELECT 'power.off' WHERE json_extract(device_capabilities.config_json, '$.announcePower')
                UNION ALL SELECT 'start' WHERE json_extract(device_capabilities.config_json, '$.announceStarts')
                UNION ALL SELECT 'card' WHERE json_extract(device_capabilities.config_json, '$.announceCards')
                UNION ALL SELECT 'request.coin' WHERE json_extract(device_capabilities.config_json, '$.announceCoins')
              )
            )
          END
        ),
        'sources', json('[]'),
        'to', json(json_extract(config_json, '$.announceChannelIds')),
        'staff', json('false')
      ))
      ELSE json('[]')
    END
  ),
  '$.announceChannelIds', '$.announceEvents',
  '$.announceIdle', '$.announcePower', '$.announceStarts', '$.announceCards', '$.announceCoins'
)
WHERE capability = 'bot';
