-- A bot announces by groups now: each is one audience (where it is said) with
-- a whole table of what it says, from where, and in which words
-- (`AnnouncementGroup` in @prism/core).
--
-- Each listening rule becomes a group of its own, named in order: the events it
-- listened for are on, each with the rule's sources, and its destinations stay
-- as they were. A rule that also told every staff member privately has their
-- private chats written into its destinations, as anyone's are: the staff who
-- work at the shop and bound a platform identity there now. The bot's announcement words were the bot's alone;
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
        'to', json(COALESCE((
          SELECT json_group_array(d.dest) FROM (
            SELECT t.value AS dest FROM json_each(r.value, '$.to') t
            UNION
            SELECT b.provider || ':private:' || b.subject FROM shop_platform_bindings b
            WHERE json_extract(r.value, '$.staff') AND b.shop_id = device_capabilities.shop_id AND (
              b.user_id IN (SELECT user_id FROM shop_members WHERE shop_id = b.shop_id)
              OR b.user_id IN (
                SELECT a.user_id FROM shop_staff_accounts a
                JOIN staff_users s ON s.shop_id = a.shop_id AND s.id = a.staff_id
                WHERE a.shop_id = b.shop_id AND s.status = 'active'))
          ) d
        ), '[]')),
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
