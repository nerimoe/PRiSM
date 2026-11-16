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
--
-- The switches are read from a list rather than one SELECT per switch joined by
-- UNION ALL: D1 allows five terms in a compound SELECT, and there are six.
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
              SELECT json_group_array(json_extract(old.value, '$[0]'))
              FROM json_each('[["idle.reminder","$.announceIdle"],["power.on","$.announcePower"],["power.off","$.announcePower"],["start","$.announceStarts"],["card","$.announceCards"],["request.coin","$.announceCoins"]]') AS old
              WHERE json_extract(device_capabilities.config_json, json_extract(old.value, '$[1]'))
            )
          END
        ) > 0
      THEN json_array(json_object(
        'events', json(
          CASE
            WHEN json_type(config_json, '$.announceEvents') = 'array' THEN json_extract(config_json, '$.announceEvents')
            ELSE (
              SELECT json_group_array(json_extract(old.value, '$[0]'))
              FROM json_each('[["idle.reminder","$.announceIdle"],["power.on","$.announcePower"],["power.off","$.announcePower"],["start","$.announceStarts"],["card","$.announceCards"],["request.coin","$.announceCoins"]]') AS old
              WHERE json_extract(device_capabilities.config_json, json_extract(old.value, '$[1]'))
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
