-- Every identity a shop profile has lives in player_identities, the PRiSM web
-- account included: provider 'web-account', subject = the account's user ID.
-- shop_player_accounts (account -> profile) and shop_platform_bindings
-- (account -> verified chat identity) only repeated what these rows say, and
-- went stale whenever an identity was removed.

-- Moving rows must not stop at a shop frozen for export; its lock triggers are
-- put back unchanged at the end.
DROP TRIGGER IF EXISTS shop_export_player_identities_insert;
DROP TRIGGER IF EXISTS shop_export_player_identities_update;
DROP TRIGGER IF EXISTS shop_export_player_identities_delete;

-- 1. A binding whose identity row went missing keeps it on the account's profile.
--    Cashier profiles never carry identities.
INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at)
SELECT b.shop_id, a.player_id, b.provider, b.subject, b.verified_at
FROM shop_platform_bindings b
JOIN shop_player_accounts a ON a.shop_id = b.shop_id AND a.user_id = b.user_id
WHERE NOT EXISTS (SELECT 1 FROM cashier_profiles c WHERE c.shop_id = b.shop_id AND c.player_id = a.player_id)
ON CONFLICT(shop_id, provider, subject) DO NOTHING;

-- 2. shop_player_accounts was authoritative: drop a web-account identity that
--    puts another account on a profile it links, then write each link, moving
--    an account's identity to the profile the table names.
DELETE FROM player_identities
WHERE provider = 'web-account' AND EXISTS (
  SELECT 1 FROM shop_player_accounts a
  WHERE a.shop_id = player_identities.shop_id AND a.player_id = player_identities.player_id
    AND a.user_id <> player_identities.subject);

INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at)
SELECT a.shop_id, a.player_id, 'web-account', a.user_id, a.verified_at
FROM shop_player_accounts a
WHERE NOT EXISTS (SELECT 1 FROM cashier_profiles c WHERE c.shop_id = a.shop_id AND c.player_id = a.player_id)
ON CONFLICT(shop_id, provider, subject) DO UPDATE SET player_id = excluded.player_id;

-- 3. One account per profile: keep the earliest of any remaining duplicates.
DELETE FROM player_identities
WHERE provider = 'web-account' AND rowid NOT IN (
  SELECT MIN(rowid) FROM player_identities WHERE provider = 'web-account' GROUP BY shop_id, player_id);

CREATE UNIQUE INDEX IF NOT EXISTS player_identities_one_account
  ON player_identities(shop_id, player_id) WHERE provider = 'web-account';
-- An account's profiles across shops (cards, account deletion, "my shops").
CREATE INDEX IF NOT EXISTS player_identities_account
  ON player_identities(subject) WHERE provider = 'web-account';

CREATE TRIGGER shop_export_player_identities_insert BEFORE INSERT ON player_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_identities_update BEFORE UPDATE ON player_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id OR e.shop_id=NEW.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_player_identities_delete BEFORE DELETE ON player_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (e.shop_id=OLD.shop_id)
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

-- 4. The login-identity export locks find a shop's accounts without the old table.
DROP TRIGGER IF EXISTS shop_export_auth_identities_insert;
DROP TRIGGER IF EXISTS shop_export_auth_identities_update;
DROP TRIGGER IF EXISTS shop_export_auth_identities_delete;
CREATE TRIGGER shop_export_auth_identities_insert BEFORE INSERT ON auth_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=NEW.user_id))
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_auth_identities_update BEFORE UPDATE ON auth_identities
 WHEN (OLD.user_id IS NOT NEW.user_id OR OLD.provider IS NOT NEW.provider OR OLD.provider_subject IS NOT NEW.provider_subject) AND EXISTS(SELECT 1 FROM shop_data_exports e WHERE (EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=OLD.user_id) OR EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=NEW.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=NEW.user_id))
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;
CREATE TRIGGER shop_export_auth_identities_delete BEFORE DELETE ON auth_identities
 WHEN EXISTS(SELECT 1 FROM shop_data_exports e WHERE (EXISTS(SELECT 1 FROM shop_members m WHERE m.shop_id=e.shop_id AND m.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM shop_staff_accounts a WHERE a.shop_id=e.shop_id AND a.user_id=OLD.user_id)
    OR EXISTS(SELECT 1 FROM player_identities i WHERE i.shop_id=e.shop_id AND i.provider='web-account' AND i.subject=OLD.user_id))
  AND e.status='active' AND e.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'SHOP_EXPORT_LOCKED'); END;

-- 5. Dropping the tables drops their own triggers.
DROP TABLE IF EXISTS shop_platform_bindings;
DROP TABLE IF EXISTS shop_player_accounts;
