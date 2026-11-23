-- Staff checkout receipts are now ordinary `checkout.settled` deliveries in
-- an announcement group rather than a separate per-bot toggle (`receiptsToStaff`).
--
-- Any bot that had `receiptsToStaff` enabled (and fewer than 10 groups) gets a
-- `结账回执` announcement group appended, listening to `checkout.settled` from
-- all sources and targeting the private chats of the shop's staff at migration
-- time (the owner/members plus active staff accounts with bound platform
-- identities). Every bot row has `$.receiptsToStaff` removed afterwards.
UPDATE device_capabilities
SET config_json = json_remove(
  CASE
    WHEN json_type(config_json, '$.receiptsToStaff') = 'true'
      AND (
        COALESCE(json_type(config_json, '$.announceGroups'), '') <> 'array'
        OR json_array_length(config_json, '$.announceGroups') < 10
      )
    THEN json_set(
      config_json,
      '$.announceGroups',
      json(json_insert(
        CASE
          WHEN json_type(config_json, '$.announceGroups') = 'array'
          THEN json(json_extract(config_json, '$.announceGroups'))
          ELSE json('[]')
        END,
        '$[#]',
        json_object(
          'id', 'receipts-to-staff',
          'name', '结账回执',
          'to', json(COALESCE((
            SELECT json_group_array(d.dest)
            FROM (
              SELECT DISTINCT b.provider || ':private:' || b.subject AS dest
              FROM shop_platform_bindings b
              WHERE b.shop_id = device_capabilities.shop_id AND (
                b.user_id IN (SELECT user_id FROM shop_members WHERE shop_id = b.shop_id)
                OR b.user_id IN (
                  SELECT a.user_id FROM shop_staff_accounts a
                  JOIN staff_users s ON s.shop_id = a.shop_id AND s.id = a.staff_id
                  WHERE a.shop_id = b.shop_id AND s.status = 'active'
                )
              )
              ORDER BY dest
              LIMIT 20
            ) d
          ), '[]')),
          'events', json_object('checkout.settled', json_object('on', json('true'), 'sources', json('[]'))),
          'templates', json('{}')
        )
      ))
    )
    ELSE config_json
  END,
  '$.receiptsToStaff'
)
WHERE capability = 'bot';
