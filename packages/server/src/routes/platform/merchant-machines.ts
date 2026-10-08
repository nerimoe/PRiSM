import { Hono, type Context } from "hono";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { decryptSecret } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";

/** Restore pre-fork merchant machine discovery and audit-history contracts. */
export const merchantMachineRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;
type MachineRecord = {
  id: string;
  shop_id: string;
  shop_public_id: string;
  public_id: string;
  name: string;
  enabled: number;
  kind: string;
  aliases_json: string | null;
  hinata_url_encrypted: string | null;
  hinata_password_encrypted: string | null;
  ha_binding_encrypted: string | null;
  ttlock_lock_id: number | null;
  mahjong_config_json: string | null;
  coin_key: number;
  coin_after_swipe: number;
};

function parseObject(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function assertMachineShop(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return;
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=?",
  ).bind(shopId, user.id).first();
  if (!member) jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
}

async function canConfigureMachine(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return true;
  const row = await c.env.DB.prepare(
    "SELECT s.role FROM shop_staff_accounts a JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE a.shop_id=? AND a.user_id=? AND s.status='active'",
  ).bind(shopId, user.id).first<{ role: string }>();
  return row?.role !== "viewer";
}

async function decode(c: C, value: string) {
  if (!c.env.URL_ENCRYPTION_KEY) jsonError(503, "设备密钥未配置", "DEVICE_ENCRYPTION_UNAVAILABLE");
  return decryptSecret(value, c.env.URL_ENCRYPTION_KEY);
}

async function presentMachine(c: C, row: MachineRecord, canConfigure: boolean) {
  const aliases = parseObject(row.aliases_json);
  const ha = row.ha_binding_encrypted
    ? JSON.parse(await decode(c, row.ha_binding_encrypted)) as { url: string; entityId: string; token: string }
    : null;
  return {
    id: row.id,
    publicId: row.public_id,
    shopId: row.shop_id,
    shopPublicId: row.shop_public_id,
    name: row.name,
    aliases: Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string") : [],
    enabled: !!row.enabled,
    kind: row.kind,
    hasHinata: !!row.hinata_url_encrypted,
    hinataUrl: canConfigure && row.hinata_url_encrypted ? await decode(c, row.hinata_url_encrypted) : null,
    hasPassword: !!row.hinata_password_encrypted,
    homeAssistant: ha ? { url: canConfigure ? ha.url : "", entityId: ha.entityId } : null,
    ttlockLockId: row.ttlock_lock_id,
    mahjong: parseObject(row.mahjong_config_json),
    coinKey: row.coin_key,
    coinEnabled: row.coin_key > 0,
    coinAfterSwipe: !!row.coin_after_swipe,
  };
}

merchantMachineRouter.get("/machines", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertMachineShop(c, user, shopId);
  const canConfigure = await canConfigureMachine(c, user, shopId);
  const machines = await c.env.DB.prepare(
    `SELECT machines.*, shops.public_id AS shop_public_id
     FROM machines JOIN shops ON shops.id=machines.shop_id
     WHERE machines.shop_id=? ORDER BY (machines.ttlock_lock_id IS NOT NULL) DESC,machines.created_at`,
  ).bind(shopId).all<MachineRecord>();
  return c.json({ machines: await Promise.all(machines.results.map(m => presentMachine(c,m,canConfigure))) });
});

merchantMachineRouter.get("/machines/:id/events", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
  await assertMachineShop(c,user,machine.shop_id);
  const rows = await c.env.DB.prepare(
    "SELECT id,type,status,requested_at AS requestedAt FROM device_commands WHERE shop_id=? AND device_id=? ORDER BY requested_at DESC LIMIT 30",
  ).bind(machine.shop_id,c.req.param("id")).all();
  return c.json({ events: rows.results });
});

merchantMachineRouter.get("/login-events", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  const machineId = c.req.query("machineId");
  if (shopId) await assertMachineShop(c,user,shopId);
  if (machineId) {
    const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
      .bind(machineId).first<{ shop_id: string }>();
    if (!machine) jsonError(404, "没有找到这台设备", "DEVICE_NOT_FOUND");
    await assertMachineShop(c,user,machine.shop_id);
  }
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100,Math.max(1,Math.floor(requestedLimit))) : 50;
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (user.role !== "admin") {
    where.push("EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id=shops.id AND sm.user_id=?)");
    bindings.push(user.id);
  }
  if (shopId) { where.push("shops.id=?"); bindings.push(shopId); }
  if (machineId) { where.push("machines.id=?"); bindings.push(machineId); }
  const sql = `SELECT e.id, e.created_at AS createdAt, e.result, e.risk_result AS riskResult,
    e.response_code AS responseCode, e.error_message AS errorMessage,
    e.distance_meters AS distanceMeters, machines.name AS machineName,
    shops.name AS shopName, i.display_name AS userName, cards.label AS cardLabel
    FROM machine_login_events e
    LEFT JOIN machines ON machines.id=e.machine_id
    LEFT JOIN shops ON shops.id=machines.shop_id
    LEFT JOIN users ON users.id=e.user_id
    LEFT JOIN auth_identities i ON i.id=(SELECT id FROM auth_identities WHERE user_id=users.id AND provider='munet' ORDER BY created_at LIMIT 1)
    LEFT JOIN cards ON cards.id=e.card_id
    ${where.length ? "WHERE "+where.join(" AND ") : ""}
    ORDER BY e.created_at DESC LIMIT ?`;
  const result = await c.env.DB.prepare(sql).bind(...bindings,limit).all();
  return c.json({ events: result.results });
});
