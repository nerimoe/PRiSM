import type { Context } from "hono";
import type { AppBindings, LegacyD1Database as D1Database, LegacyD1PreparedStatement as D1PreparedStatement } from "./compat.js";
import { jsonError } from "../../../http.js";

type Link = {
  source_user_id: string;
  player_id: string | null;
  staff_id: string | null;
  member_role: string | null;
  verified_at: string | null;
  identities_json: string;
  platform_bindings_json: string;
};
export function accountLinkStatements(
  db: D1Database,
  shopId: string,
  link: Link,
  userId: string,
): D1PreparedStatement[] {
  const now = new Date().toISOString(),
    statements: D1PreparedStatement[] = [];
  if (link.player_id) {
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES (?,?,?,?)
      ON CONFLICT(shop_id,user_id) DO UPDATE SET player_id=CASE WHEN shop_player_accounts.player_id=excluded.player_id
        THEN shop_player_accounts.player_id ELSE NULL END`,
        )
        .bind(shopId, userId, link.player_id, link.verified_at ?? now),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,?,'web-account',?,?)
      ON CONFLICT(shop_id,provider,subject) DO UPDATE SET player_id=CASE WHEN player_identities.player_id=excluded.player_id
        THEN player_identities.player_id ELSE NULL END`,
        )
        .bind(shopId, link.player_id, userId, link.verified_at ?? now),
    );
    const bindings = JSON.parse(link.platform_bindings_json) as {
      provider: string;
      subject: string;
      verified_at: string;
    }[];
    for (const binding of bindings)
      statements.push(
        db
          .prepare(
            `INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at)
      VALUES (?,?,?,?,?) ON CONFLICT(shop_id,provider,subject) DO UPDATE SET user_id=CASE WHEN shop_platform_bindings.user_id=excluded.user_id
        THEN shop_platform_bindings.user_id ELSE NULL END`,
          )
          .bind(shopId, userId, binding.provider, binding.subject, binding.verified_at),
      );
  }
  if (link.member_role)
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_members(id,shop_id,user_id,role,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(shop_id,user_id) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), shopId, userId, link.member_role, now),
    );
  if (link.staff_id)
    statements.push(
      db
        .prepare(
          `INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,?,?)
    ON CONFLICT(shop_id,user_id) DO NOTHING`,
        )
        .bind(shopId, userId, link.staff_id),
    );
  statements.push(
    db
      .prepare("UPDATE shop_imported_accounts SET matched_user_id=? WHERE shop_id=? AND source_user_id=?")
      .bind(userId, shopId, link.source_user_id),
  );
  return statements;
}
/** Match a verified local account; importing shop data never installs global login credentials. */
export async function reconnectImportedAccount(c: Context<AppBindings>, shopId: string) {
  const user = c.get("user");
  if (!user) return;
  const marker = await (c.env.DB as LegacyD1Database).prepare(
    "SELECT 1 FROM app_settings WHERE shop_id=? AND key='backup.importedAccounts'",
  )
    .bind(shopId)
    .first();
  if (!marker) return;
  const links = (
    await (c.env.DB as LegacyD1Database).prepare(
      `SELECT h.* FROM shop_imported_accounts h WHERE h.shop_id=? AND h.matched_user_id IS NULL
    AND (h.source_user_id=? OR EXISTS(SELECT 1 FROM auth_identities a JOIN json_each(h.identities_json) j
      ON json_extract(j.value,'$.provider')=a.provider AND json_extract(j.value,'$.subject')=a.provider_subject WHERE a.user_id=?))`,
    )
      .bind(shopId, user.id, user.id)
      .all<Link>()
  ).results;
  if (links.length > 1 && new Set(links.filter((l) => l.player_id).map((l) => l.player_id)).size > 1)
    jsonError(409, "导入账号关联存在冲突，请联系店主处理", "IMPORT_ACCOUNT_CONFLICT");
  if (links.length) {
    try {
      await (c.env.DB as LegacyD1Database).batch(links.flatMap((link) => accountLinkStatements(c.env.DB as LegacyD1Database, shopId, link, user.id)));
    } catch (error) {
      if (String(error).includes("constraint failed") || String(error).includes("platform binding identity"))
        jsonError(409, "导入账号关联存在冲突，请联系店主处理", "IMPORT_ACCOUNT_CONFLICT");
      throw error;
    }
  }
}
