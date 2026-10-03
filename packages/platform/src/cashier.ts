import type { Context, Hono } from "hono";
import { z } from "zod";
import { createD1Repositories } from "@prism/adapter-d1";
import { withOperationLease } from "@prism/application";
import { toPlayerCheckoutPreviewView, toPlayerCheckoutResultView } from "@prism/server-hono";
import { dependencies, getBillingShop, staffPrincipal, type BillingShop } from "./billing";
import { jsonError } from "./http";
import { runPlayerOperation } from "./operations";
import type { AppBindings } from "./types";

type C = Context<AppBindings>;
const card = z.object({
  kind: z.enum(["type-a", "felica"]),
  uid: z.string().trim().transform(value => value.toUpperCase()).pipe(z.string().regex(/^(?:[0-9A-F]{2}){4,10}$/)),
}).refine(value => value.kind !== "felica" || value.uid.length === 16, "FeliCa IDm 必须为 8 字节");
const operationId = z.string().uuid();
function repositories(c: C, shop: BillingShop) {
  return createD1Repositories({ db: c.env.DB, shopId: shop.id, id: crypto.randomUUID, now: () => new Date() });
}
async function profile(c: C, shop: BillingShop, playerId: string) {
  const found = await c.env.DB.prepare(`SELECT p.id, p.display_name AS displayName, p.status,
    cp.card_kind AS kind, cp.card_uid AS uid FROM cashier_profiles cp
    JOIN players p ON p.shop_id=cp.shop_id AND p.id=cp.player_id WHERE cp.shop_id=? AND cp.player_id=?`)
    .bind(shop.id, playerId).first<{ id: string; displayName: string; status: string; kind: string; uid: string }>();
  if (!found) jsonError(404, "没有找到前台卡片档案", "CASHIER_PROFILE_NOT_FOUND");
  const repos = repositories(c, shop);
  const sessions = [...await repos.sessions.findActiveByPlayerId(playerId), ...await repos.sessions.findUnpaidClosedByPlayerId(playerId)];
  return { ...found, paymentMode: "cashier", sessions };
}

export function registerCashierRoutes(app: Hono<AppBindings>) {
  const base = "/api/v1/shops/:shopCode/cashier";
  app.use(base + "/*", async (c, next) => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    const staff = await staffPrincipal(c, shop);
    if (staff.staffRole === "viewer") jsonError(403, "只读账号不能操作前台收银", "FORBIDDEN");
    const run = async () => {
      const current = await getBillingShop(c, c.req.param("shopCode")!);
      if (!current.billing_enabled) jsonError(409, "店铺未启用计费", "BILLING_DISABLED");
      if (!current.cashier_enabled) jsonError(409, "店铺未启用前台收银", "CASHIER_DISABLED");
      await next();
    };
    // Serialize mode changes with registration, entry and collection so disabling
    // cannot strand a visit that starts concurrently with the settings update.
    if (c.req.method === "POST" && !c.req.path.endsWith("/lookup") && !c.req.path.endsWith("/preview")) {
      await withOperationLease({ repository: repositories(c, shop).operationLocks, scope: "shop.cashier", resourceId: shop.id, now: () => new Date() }, run);
    } else await run();
  });
  app.post(base + "/lookup", async c => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    const value = card.parse(await c.req.json());
    const found = await c.env.DB.prepare("SELECT player_id FROM cashier_profiles WHERE shop_id=? AND card_kind=? AND card_uid=?")
      .bind(shop.id, value.kind, value.uid).first<{ player_id: string }>();
    return c.json({ profile: found ? await profile(c, shop, found.player_id) : null });
  });
  app.get(base + "/profiles/:playerId", async c => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    return c.json({ profile: await profile(c, shop, c.req.param("playerId")!) });
  });
  app.post(base + "/register", async c => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    const body = z.object({ card, displayName: z.string().trim().min(1).max(80), operationId }).parse(await c.req.json());
    return runPlayerOperation(c, shop.id, "cashier/register", body, async () => {
      const repos = repositories(c, shop);
      return withOperationLease({ repository: repos.operationLocks, scope: "cashier.card", resourceId: `${body.card.kind}:${body.card.uid}`, now: () => new Date() }, async () => {
        const exists = await c.env.DB.prepare("SELECT player_id FROM cashier_profiles WHERE shop_id=? AND card_kind=? AND card_uid=?")
          .bind(shop.id, body.card.kind, body.card.uid).first();
        if (exists) jsonError(409, "此卡已绑定档案，请重新刷卡", "CASHIER_CARD_BOUND");
        const id = crypto.randomUUID();
        const at = new Date().toISOString();
        // No registration gifts, platform identity or global account are created.
        await c.env.DB.batch([
          c.env.DB.prepare("INSERT INTO players (shop_id,id,display_name,status,created_at) VALUES (?,?,?,'active',?)").bind(shop.id, id, body.displayName, at),
          c.env.DB.prepare("INSERT INTO cashier_profiles (shop_id,player_id,card_kind,card_uid,created_at) VALUES (?,?,?,?,?)").bind(shop.id, id, body.card.kind, body.card.uid, at),
        ]);
        return c.json({ profile: await profile(c, shop, id) }, 201);
      });
    });
  });
  app.post(base + "/profiles/:playerId/entry", async c => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    const principal = await staffPrincipal(c, shop);
    const playerId = c.req.param("playerId")!;
    const body = z.object({ operationId }).parse(await c.req.json());
    return runPlayerOperation(c, shop.id, "cashier/entry/" + playerId, body, async () => {
      const repos = repositories(c, shop);
      return withOperationLease({ repository: repos.operationLocks, scope: "player.assets", resourceId: playerId, now: () => new Date() }, async () => {
        const player = await profile(c, shop, playerId);
        if (player.status !== "active") jsonError(403, "店铺玩家资格已停用", "PLAYER_DISABLED");
        if (player.sessions.some(session => session.status === "closed")) jsonError(409, "请先结清上次账单", "CASHIER_UNPAID_VISIT");
        const session = await dependencies(c, shop).playerCommands.startSession({ playerId, metadata: { createdBy: "cashier", staffId: principal.staffId } });
        return c.json({ session, profile: await profile(c, shop, playerId) });
      });
    });
  });
  app.post(base + "/profiles/:playerId/checkout/preview", async c => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    const playerId = c.req.param("playerId")!;
    await profile(c, shop, playerId);
    const commands = dependencies(c, shop).staffCheckoutCommands!;
    const preview = await commands.previewCheckout!({ playerId });
    return c.json(toPlayerCheckoutPreviewView(preview));
  });
  app.post(base + "/profiles/:playerId/checkout/confirm", async c => {
    const shop = await getBillingShop(c, c.req.param("shopCode")!);
    const staff = await staffPrincipal(c, shop);
    const playerId = c.req.param("playerId")!;
    const body = z.object({ operationId, collected: z.literal(true), method: z.enum(["wechat", "alipay", "cash", "other"]),
      previewedAt: z.string().datetime(), expectedTotal: z.number().finite().nonnegative(), sessionIds: z.array(z.string().min(1)).min(1).max(100) }).parse(await c.req.json());
    return runPlayerOperation(c, shop.id, "cashier/checkout/" + playerId, body, async () => {
      await profile(c, shop, playerId);
      const commands = dependencies(c, shop).staffCheckoutCommands!;
      const result = await commands.checkoutExternal!({ ...body, playerId, staffId: staff.staffId, previewedAt: new Date(body.previewedAt) });
      return c.json({ ...toPlayerCheckoutResultView(result), payment: { method: body.method, staffId: staff.staffId, collected: true } });
    });
  });
}
