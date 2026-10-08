import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireAdmin } from "../../middleware/auth.js";

export const adminManagementRouter = new Hono<AppBindings>();
const roleInput = z.object({ userId: z.string().min(1), role: z.enum(["user", "admin"]) });
const banInput = z.object({
  subjectType: z.enum(["user", "ip", "card", "machine"]),
  subjectValue: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(200),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

adminManagementRouter.post("/users/role", async (c) => {
  requireAdmin(c);
  const body = roleInput.parse(await c.req.json());
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE id=?").bind(body.userId).first();
  if (!existing) jsonError(404, "没有找到这个用户", "USER_NOT_FOUND");
  await c.env.DB.prepare("UPDATE users SET role=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(body.role, body.userId).run();
  return c.json({ ok: true });
});

adminManagementRouter.get("/users", async (c) => {
  requireAdmin(c);
  const query = c.req.query("query")?.trim().toLowerCase();
  const statement = query
    ? c.env.DB.prepare(
      `SELECT u.id, i.username, i.display_name AS displayName, u.role,
      u.banned_at AS bannedAt, u.created_at AS createdAt
      FROM users u LEFT JOIN auth_identities i ON i.id=(
        SELECT id FROM auth_identities WHERE user_id=u.id
        ORDER BY CASE WHEN provider='munet' THEN 0 ELSE 1 END, created_at LIMIT 1)
      WHERE lower(COALESCE(i.username,'')) LIKE ? OR lower(COALESCE(i.display_name,'')) LIKE ? OR u.id LIKE ?
      ORDER BY u.created_at DESC LIMIT 50`,
    ).bind(`%${query}%`, `%${query}%`, `%${query}%`)
    : c.env.DB.prepare(
      `SELECT u.id, i.username, i.display_name AS displayName, u.role,
      u.banned_at AS bannedAt, u.created_at AS createdAt
      FROM users u LEFT JOIN auth_identities i ON i.id=(
        SELECT id FROM auth_identities WHERE user_id=u.id
        ORDER BY CASE WHEN provider='munet' THEN 0 ELSE 1 END, created_at LIMIT 1)
      ORDER BY u.created_at DESC LIMIT 50`,
    ).bind();
  const users = await statement.all();
  return c.json({ users: users.results });
});

adminManagementRouter.get("/bans", async (c) => {
  requireAdmin(c);
  const bans = await c.env.DB.prepare(
    "SELECT id, subject_type AS subjectType, subject_value AS subjectValue, reason, expires_at AS expiresAt, created_at AS createdAt FROM bans ORDER BY created_at DESC LIMIT 100",
  ).bind().all();
  return c.json({ bans: bans.results });
});

adminManagementRouter.post("/bans", async (c) => {
  requireAdmin(c);
  const body = banInput.parse(await c.req.json());
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO bans(id,subject_type,subject_value,reason,expires_at)
      VALUES (COALESCE((SELECT id FROM bans WHERE subject_type=? AND subject_value=?),?),?,?,?,?)`,
  ).bind(body.subjectType, body.subjectValue, crypto.randomUUID(),
    body.subjectType, body.subjectValue, body.reason, body.expiresAt ?? null).run();
  return c.json({ ok: true }, 201);
});

adminManagementRouter.delete("/bans/:id", async (c) => {
  requireAdmin(c);
  await c.env.DB.prepare("DELETE FROM bans WHERE id=?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Preserve the original admin deletion transaction and ownership transfer safeguards.
adminManagementRouter.delete("/users/:id", async (c) => {
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
    if (!((results as Array<{ meta?: { changes?: number } }>).at(-1)?.meta?.changes) jsonError(409, "账号已变化，请刷新后重试");
    return c.json({ ok: true });
  });
