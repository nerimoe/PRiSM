-- A bot announces by groups now: each is one audience (where it is said, and
-- whether staff hear it privately) with a whole table of what it says, from
-- where, and in which words (`AnnouncementGroup` in @prism/core).
--
-- Each listening rule becomes a group of its own, named in order: the events it
-- listened for are on, each with the rule's sources, and its destinations and
-- staff stay as they were. The bot's announcement words were the bot's alone;
-- each group starts with a copy of them, and the bot keeps only the words of
-- its answers to commands.
UPDATE device_capabilities
SET config_json = json_remove(
  json_set(
    config_json,
    '$.announceGroups',
    (
      SELECT json_group_array(json_object(
        'id', 'group-' || (r.key + 1),
        'name', '播报组 ' || (r.key + 1),
        'to', json(COALESCE(json_extract(r.value, '$.to'), '[]')),
        'staff', json(CASE WHEN json_extract(r.value, '$.staff') THEN 'true' ELSE 'false' END),
        'events', json((
          SELECT json_group_object(e.value, json_object('on', json('true'), 'sources', json(COALESCE(json_extract(r.value, '$.sources'), '[]'))))
          FROM json_each(r.value, '$.events') e
        )),
        'templates', json((
          SELECT json_group_object(t.key, t.value)
          FROM json_each(device_capabilities.config_json, '$.replyTemplates') t
          WHERE t.key LIKE 'announce.%'
        ))
      ))
      FROM json_each(device_capabilities.config_json, '$.announceRules') r
    ),
    '$.replyTemplates',
    json((
      SELECT json_group_object(t.key, t.value)
      FROM json_each(device_capabilities.config_json, '$.replyTemplates') t
      WHERE t.key NOT LIKE 'announce.%'
    ))
  ),
  '$.announceRules'
)
WHERE capability = 'bot';
