import type { Hono } from "hono";
import { requireAdmin } from "./auth";
import { jsonError } from "./http";
import type { AppBindings } from "./types";

export function registerAdminAccountRoutes(app: Hono<AppBindings>) {
  app.delete("/api/v1/admin/users/:id", async (c) => {
    const admin = requireAdmin(c);
    const userId = c.req.param("id");
    if (userId === admin.id)
      jsonError(409, "当前登录账号不能删除，请使用另一个管理员账号操作", "CANNOT_DELETE_CURRENT_USER");
    const target = await c.env.DB.prepare("SELECT id FROM users WHERE id=?").bind(userId).first();
    if (!target) jsonError(404, "没有找到这个用户");

    // Recheck both accounts inside the transaction: concurrent administrators
    // cannot delete each other using authorization from an earlier request.
    const guard = `EXISTS (SELECT 1 FROM users WHERE id=? AND role='admin' AND banned_at IS NULL)
      AND EXISTS (SELECT 1 FROM users WHERE id=?)`;
    const statement = (sql: string, ...values: string[]) =>
      c.env.DB.prepare(sql).bind(...values, admin.id, userId);
    const results = await c.env.DB.batch([
      // Preserve stores and their business records, without displacing another owner.
      statement(`INSERT INTO shop_members (id,shop_id,user_id,role)
        SELECT ? || s.id, s.id, ?, 'owner' FROM shops s
        WHERE (s.created_by=? OR EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id=s.id AND m.user_id=? AND m.role='owner'))
          AND NOT EXISTS (SELECT 1 FROM shop_members m WHERE m.shop_id=s.id AND m.user_id<>? AND m.role='owner')
          AND ${guard}
        ON CONFLICT(shop_id,user_id) DO UPDATE SET role='owner'`, crypto.randomUUID() + ":", admin.id, userId, userId, userId),
      statement(`UPDATE shops SET created_by=COALESCE(
        (SELECT m.user_id FROM shop_members m WHERE m.shop_id=shops.id AND m.user_id<>? AND m.role='owner' ORDER BY m.created_at,m.id LIMIT 1), ?),
        updated_at=CURRENT_TIMESTAMP WHERE created_by=? AND ${guard}`, userId, admin.id, userId),
      statement(`DELETE FROM live_activity_tokens WHERE user_id=? AND ${guard}`, userId),
      statement(`DELETE FROM live_activity_start_tokens WHERE user_id=? AND ${guard}`, userId),
      // Claimed tickets must be revoked, rather than made claimable by another user.
      statement(`DELETE FROM machine_tickets WHERE claimed_by=? AND ${guard}`, userId),
      statement(`DELETE FROM platform_binding_codes WHERE user_id=? AND ${guard}`, userId),
      statement(`DELETE FROM player_operations WHERE user_id=? AND ${guard}`, userId),
      statement(`DELETE FROM shop_staff_accounts WHERE user_id=? AND ${guard}`, userId),
      statement(`DELETE FROM shop_player_accounts WHERE user_id=? AND ${guard}`, userId),
      // Login identities, OAuth credentials, sessions, challenges, passkeys,
      // cards and memberships cascade; historical login events become anonymous.
      statement(`DELETE FROM users WHERE id=? AND ${guard}`, userId),
    ]);
    if (!results.at(-1)?.meta.changes) jsonError(409, "账号已变化，请刷新后重试");
    return c.json({ ok: true });
  });
}
