import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { canAccessShop } from "./shops.js";

export const merchantMembersRouter = new Hono<AppBindings>();
const memberInput = z.object({
  shopId: z.string().min(1),
  user: z.string().trim().min(1).max(80),
  role: z.enum(["owner", "staff"]).default("staff"),
});

async function assertShopMemberAccess(c: import("hono").Context<AppBindings>, user: AuthUser, shopId: string) {
  if (!(await canAccessShop(c, user, shopId))) {
    jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
  }
}

async function assertShopOwner(c: import("hono").Context<AppBindings>, user: AuthUser, shopId: string) {
  if (user.role === "admin") return;
  const owner = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=? AND role='owner'",
  ).bind(shopId, user.id).first();
  if (!owner) jsonError(403, "只有店铺负责人可以管理成员", "FORBIDDEN");
}

merchantMembersRouter.get("/shop-members", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertShopMemberAccess(c, user, shopId);
  const members = await c.env.DB.prepare(
    `SELECT m.id,m.role,m.created_at AS createdAt,i.username,i.display_name AS displayName,u.id AS userId
    FROM shop_members m JOIN users u ON u.id=m.user_id
    LEFT JOIN auth_identities i ON i.id=(
      SELECT id FROM auth_identities WHERE user_id=u.id
      ORDER BY CASE WHEN provider='munet' THEN 0 ELSE 1 END, created_at LIMIT 1)
    WHERE m.shop_id=? ORDER BY m.created_at ASC`,
  ).bind(shopId).all();
  return c.json({ members: members.results });
});

merchantMembersRouter.post("/shop-members", async (c) => {
  const user = requireUser(c);
  const body = memberInput.parse(await c.req.json());
  await assertShopOwner(c, user, body.shopId);
  const target = await c.env.DB.prepare(
    `SELECT u.id FROM users u LEFT JOIN auth_identities i ON i.user_id=u.id
    WHERE u.id=? OR lower(i.username)=lower(?) LIMIT 1`,
  ).bind(body.user, body.user).first<{ id: string }>();
  if (!target) jsonError(404, "没有找到这个用户", "USER_NOT_FOUND");
  // A single statement enforces the last-owner invariant even for role changes.
  const updated = await c.env.DB.prepare(
    `INSERT INTO shop_members(id,shop_id,user_id,role,created_at)
    VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(shop_id,user_id) DO UPDATE SET role=excluded.role
    WHERE excluded.role='owner' OR shop_members.role!='owner'
      OR (SELECT COUNT(*) FROM shop_members WHERE shop_id=excluded.shop_id AND role='owner')>1`,
  ).bind(crypto.randomUUID(),body.shopId,target.id,body.role).run();
  if ((updated as { meta?: { changes?: number } }).meta?.changes === 0)
    jsonError(409, "至少需要保留一位店铺负责人", "LAST_OWNER_REQUIRED");
  return c.json({ ok: true });
});

merchantMembersRouter.delete("/shop-members/:id", async (c) => {
  const user = requireUser(c);
  const member = await c.env.DB.prepare(
    "SELECT id,shop_id,role FROM shop_members WHERE id=?",
  ).bind(c.req.param("id")).first<{ id: string; shop_id: string; role: string }>();
  if (!member) jsonError(404, "没有找到这个成员", "MEMBER_NOT_FOUND");
  await assertShopOwner(c, user, member.shop_id);
  const deleted = await c.env.DB.prepare(
    "DELETE FROM shop_members WHERE id=? AND (role!='owner' OR (SELECT COUNT(*) FROM shop_members WHERE shop_id=? AND role='owner')>1)",
  ).bind(member.id, member.shop_id).run();
  if ((deleted as { meta?: { changes?: number } }).meta?.changes === 0)
    jsonError(409, "至少需要保留一位店铺负责人", "LAST_OWNER_REQUIRED");
  return c.json({ ok:true });
});
