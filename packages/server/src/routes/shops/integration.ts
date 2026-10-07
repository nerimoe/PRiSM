import { Hono, type Context } from "hono";
import { yuanOf } from "@prism/core";
import type { AppBindings, TenantShop } from "../../bindings.js";
import { sha256Hex } from "../../crypto.js";
import { jsonError } from "../../http.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  toPlayerAssetsView,
  toPlayerCheckoutPreviewView,
  toPlayerCheckoutResultView,
  toPlayerManagementView,
  toRedeemGiftView,
  toSessionHistoryView,
  toSessionView,
  toStaffActiveSessionView,
  toStoppedSessionView,
} from "./views.js";

async function requireIntegrationAuth(
  c: Context<AppBindings>,
  shop: TenantShop,
): Promise<void> {
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) {
    const user = c.get("user");
    if (user?.role === "admin") return;
    jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  }

  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    "SELECT id, role, status FROM api_tokens WHERE shop_id = ? AND token_hash = ? AND status = 'active'",
  )
    .bind(shop.id, tokenHash)
    .first<{ id: string; role: string; status: string }>();

  if (!row || row.role !== "integration") {
    const user = c.get("user");
    if (user?.role === "admin") return;
    jsonError(403, "店铺 Bot 凭据无效", "FORBIDDEN");
  }
}

export const integrationRouter = new Hono<AppBindings>();

integrationRouter.use("*", async (c, next) => {
  const shop = getShop(c);
  if (!shop.billing_enabled) {
    jsonError(409, "店铺未启用计费", "BILLING_DISABLED");
  }
  await requireIntegrationAuth(c, shop);
  await next();
});

// Resolve player by identity
integrationRouter.post("/players/by-identity/resolve", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<{ provider: string; subject: string }>();
  const player = await deps.integrationCommands.resolvePlayerByIdentity({
    identity: { provider: body.provider, subject: body.subject },
  });
  return c.json({ player: toPlayerManagementView(player) });
});

// Register player by identity
integrationRouter.post("/players/by-identity/register", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<{ provider: string; subject: string; displayName?: string }>();
  const player = await deps.integrationCommands.resolveOrRegisterPlayerByIdentity({
    identity: { provider: body.provider, subject: body.subject },
    displayName: body.displayName,
    autoRegister: true,
  });
  return c.json({ player: toPlayerManagementView(player) });
});

// Start session by identity
integrationRouter.post("/players/by-identity/session/start", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const session = await deps.integrationCommands.startSessionByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
  });
  return c.json({ session: toSessionView(session) });
});

// Stop session by identity
integrationRouter.post("/players/by-identity/sessions/:sessionId/stop", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const session = await deps.integrationCommands.stopSessionByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
    sessionId: c.req.param("sessionId"),
  });
  return c.json(toStoppedSessionView(session));
});

// Checkout preview by identity
integrationRouter.post("/players/by-identity/checkout/preview", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.previewCheckoutByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
  });
  return c.json(toPlayerCheckoutPreviewView(result));
});

// Checkout confirm by identity
integrationRouter.post("/players/by-identity/checkout/confirm", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.confirmCheckoutByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
  });
  return c.json(toPlayerCheckoutResultView(result));
});

// Get wallet by identity
integrationRouter.post("/players/by-identity/wallet", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const wallet = await deps.integrationCommands.getWalletByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
  });
  return c.json({
    wallet: (wallet ?? []).map((entry: any) => ({
      ...entry,
      quantity: yuanOf(entry.quantity),
    })),
  });
});

// Get assets by identity
integrationRouter.post("/players/by-identity/assets", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const assets = await deps.integrationCommands.getAssetsByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
  });
  return c.json(assets);
});

// Get history by identity
integrationRouter.post("/players/by-identity/history", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const history = await deps.integrationCommands.getHistoryByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
  });
  return c.json(history);
});

// Redeem gift by identity
integrationRouter.post("/players/by-identity/redeem", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.redeemByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
    code: body.code,
  });
  return c.json(toRedeemGiftView(result));
});

// Adjust assets by identity
integrationRouter.post("/players/by-identity/assets/adjustments", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.adjustAssetsByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
    adjustments: body.adjustments,
  });
  return c.json(result);
});

// Adjust wallet by identity
integrationRouter.post("/players/by-identity/wallet/adjustment", async (c) => {
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const result = await deps.integrationCommands.adjustWalletByIdentity({
    ...body,
    identity: body.identity ?? (body.provider && body.subject ? { provider: body.provider, subject: body.subject } : undefined),
    amount: body.amount,
    reason: body.reason ?? "bot adjustment",
  });
  return c.json(result);
});

// Active sessions
integrationRouter.get("/sessions/active", async (c) => {
  const deps = getShopDeps(c);
  const sessions = await deps.staffQueries.listActiveSessions();
  return c.json({ sessions: sessions.map(toStaffActiveSessionView) });
});

// Device states
integrationRouter.get("/device-states", async (c) => {
  const deps = getShopDeps(c);
  const states = deps.staffQueries.listDeviceStates
    ? await deps.staffQueries.listDeviceStates()
    : [];
  return c.json({ deviceStates: states });
});
