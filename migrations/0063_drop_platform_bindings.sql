-- Platform identities live only in player_identities. A web account owns a
-- profile through shop_player_accounts, and the platform identities on that
-- profile are the account's; shop_platform_bindings only repeated the pair and
-- went stale whenever an identity was removed.
--
-- Keep any binding whose identity row is missing (it should not happen, the
-- old owner trigger required the identity) before dropping the table. Cashier
-- profiles never carry identities, and a shop frozen for export is skipped so
-- its lock trigger cannot abort the migration.
INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at)
SELECT b.shop_id, a.player_id, b.provider, b.subject, b.verified_at
FROM shop_platform_bindings b
JOIN shop_player_accounts a ON a.shop_id = b.shop_id AND a.user_id = b.user_id
WHERE NOT EXISTS (SELECT 1 FROM cashier_profiles c WHERE c.shop_id = b.shop_id AND c.player_id = a.player_id)
  AND NOT EXISTS (
    SELECT 1 FROM shop_data_exports e
    WHERE e.shop_id = b.shop_id AND e.status = 'active' AND e.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(shop_id, provider, subject) DO NOTHING;

-- Dropping the table drops its owner, export-lock and import-staleness triggers.
DROP TABLE IF EXISTS shop_platform_bindings;
