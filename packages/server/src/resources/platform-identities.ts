/**
 * Platform identities: the chat accounts (QQ, OneBot, …) on a shop player's
 * profile, kept in `player_identities` like every other identity. A PRiSM web
 * account owns a profile through its own `web-account` identity there (see
 * `account-profiles.ts`); the platform identities on that profile are the
 * account's. Nothing else records the pair: the binding code only proves an
 * account controls a chat account so it may claim the profile that identity
 * belongs to.
 *
 * Neither the PRiSM account itself (`web-account`) nor a physical card
 * (`aime`) is a platform identity.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { ACCOUNT_PROFILES_SQL } from "./account-profiles.js";

export const NON_PLATFORM_PROVIDERS = ["web-account", "aime"] as const;

/** SQL predicate on an aliased `player_identities` row: it is a platform identity. */
export function platformIdentitySql(alias: string): string {
  return `${alias}.provider NOT IN (${NON_PLATFORM_PROVIDERS.map((p) => `'${p}'`).join(",")})`;
}

/**
 * SQL `EXISTS(...)` that is true when the web account owns a profile with a
 * platform identity in the shop. Binds `shopId, userId` in that order.
 */
export const ACCOUNT_HAS_PLATFORM_IDENTITY_SQL = `EXISTS(
  SELECT 1 FROM ${ACCOUNT_PROFILES_SQL} pa
  JOIN player_identities pi ON pi.shop_id = pa.shop_id AND pi.player_id = pa.player_id
  WHERE pa.shop_id = ? AND pa.user_id = ? AND ${platformIdentitySql("pi")})`;

export async function accountHasPlatformIdentity(
  db: D1DatabaseLike,
  shopId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT ${ACCOUNT_HAS_PLATFORM_IDENTITY_SQL} AS bound`)
    .bind(shopId, userId)
    .first<{ bound: number }>();
  return !!row?.bound;
}

export type AccountPlatformIdentity = {
  playerId: string;
  provider: string;
  subject: string;
  displayName?: string;
  verifiedAt: string;
};

/** The platform identities on the profile a web account owns in a shop. */
export async function listAccountPlatformIdentities(
  db: D1DatabaseLike,
  shopId: string,
  userId: string,
): Promise<AccountPlatformIdentity[]> {
  const rows = await db
    .prepare(
      `SELECT pa.player_id AS playerId, pi.provider, pi.subject, pi.display_name AS displayName, pi.created_at AS verifiedAt
       FROM ${ACCOUNT_PROFILES_SQL} pa
       JOIN player_identities pi ON pi.shop_id = pa.shop_id AND pi.player_id = pa.player_id
       WHERE pa.shop_id = ? AND pa.user_id = ? AND ${platformIdentitySql("pi")}
       ORDER BY pi.provider, pi.subject`,
    )
    .bind(shopId, userId)
    .all<{ playerId: string; provider: string; subject: string; displayName: string | null; verifiedAt: string }>();
  return rows.results.map(({ displayName, ...row }) => ({ ...row, ...(displayName ? { displayName } : {}) }));
}
