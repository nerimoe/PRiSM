/**
 * Which shop profile a PRiSM web account owns. It is one identity among the
 * profile's others: a `player_identities` row with provider `web-account` and
 * the account's user ID as subject. The table's key keeps an account to one
 * profile per shop, and `player_identities_one_account` keeps a profile to one
 * account.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";

export const WEB_ACCOUNT_PROVIDER = "web-account";

/**
 * A row source with the columns the old `shop_player_accounts` table had
 * (`shop_id, user_id, player_id, verified_at`), for reads that join on them.
 */
export const ACCOUNT_PROFILES_SQL = `(SELECT shop_id, subject AS user_id, player_id, created_at AS verified_at
  FROM player_identities WHERE provider = '${WEB_ACCOUNT_PROVIDER}')`;

/** The profile a web account owns in a shop, if any. */
export async function accountPlayerId(db: D1DatabaseLike, shopId: string, userId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT player_id FROM player_identities WHERE shop_id = ? AND provider = '${WEB_ACCOUNT_PROVIDER}' AND subject = ?`)
    .bind(shopId, userId)
    .first<{ player_id: string }>();
  return row?.player_id ?? null;
}

/** The web account that owns a profile, if any. */
export async function profileAccountId(db: D1DatabaseLike, shopId: string, playerId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT subject FROM player_identities WHERE shop_id = ? AND player_id = ? AND provider = '${WEB_ACCOUNT_PROVIDER}'`)
    .bind(shopId, playerId)
    .first<{ subject: string }>();
  return row?.subject ?? null;
}

/**
 * Link a web account to a profile; a no-op when the account already owns one.
 * A profile that another account owns fails `player_identities_one_account`.
 */
export function linkAccountStatement(db: D1DatabaseLike, shopId: string, userId: string, playerId: string, at: string) {
  return db
    .prepare(
      `INSERT INTO player_identities (shop_id, player_id, provider, subject, created_at)
       VALUES (?, ?, '${WEB_ACCOUNT_PROVIDER}', ?, ?)
       ON CONFLICT(shop_id, provider, subject) DO NOTHING`,
    )
    .bind(shopId, playerId, userId, at);
}
