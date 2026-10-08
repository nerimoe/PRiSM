import { Hono } from "hono";
import type { AppBindings } from "../../bindings.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  toPresentManagementView,
  toRedeemCodeManagementView,
} from "./views.js";

export function createRedeemRouter(redeemCodesBase = "/codes") {
  const redeemRouter = new Hono<AppBindings>();

// List Presents
redeemRouter.get("/presents", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const presents = await deps.staffRedeemCommands.listPresents();
  return c.json({ presents: presents.map(toPresentManagementView) });
});

// Create Present
redeemRouter.post("/presents", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const present = await deps.staffRedeemCommands.createPresent({
    name: body.name,
    oncePerPlayer: body.oncePerPlayer ?? false,
    activeAt: body.activeAt ? new Date(body.activeAt) : null,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    grants: (body.grants ?? []).map((grant: any) => ({
      ...grant,
      activeAt: grant.activeAt ? new Date(grant.activeAt) : null,
      expiresAt: grant.expiresAt ? new Date(grant.expiresAt) : null,
    })),
  });
  return c.json({ present: toPresentManagementView(present) }, 201);
});

// Archive Present
redeemRouter.post("/presents/:presentId/archive", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const present = await deps.staffRedeemCommands.archivePresent({
    presentId: c.req.param("presentId"),
  });
  return c.json({ present: toPresentManagementView(present) });
});

// Restore Present
redeemRouter.post("/presents/:presentId/restore", async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const present = await deps.staffRedeemCommands.restorePresent({
    presentId: c.req.param("presentId"),
  });
  return c.json({ present: toPresentManagementView(present) });
});

// List Redeem Codes
redeemRouter.get(`${redeemCodesBase}`, async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop, true);
  const deps = getShopDeps(c);
  const [codes, redemptions] = await Promise.all([
    deps.staffRedeemCommands.listRedeemCodes(),
    deps.staffRedeemQueries?.listRedeemCodeRedemptions?.() ?? Promise.resolve([]),
  ]);
  const redemptionsByCodeId = new Map<string, typeof redemptions>();
  for (const redemption of redemptions) {
    const items = redemptionsByCodeId.get(redemption.codeId) ?? [];
    redemptionsByCodeId.set(redemption.codeId, [...items, redemption]);
  }
  return c.json({
    redeemCodes: codes.map((code) =>
      toRedeemCodeManagementView(code, redemptionsByCodeId.get(code.id) ?? []),
    ),
  });
});

// Create Redeem Code
redeemRouter.post(`${redeemCodesBase}`, async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const code = await deps.staffRedeemCommands.createRedeemCode({
    code: body.code,
    presentId: body.presentId,
    activeAt: body.activeAt ? new Date(body.activeAt) : null,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    maxUseCount: body.maxUseCount,
  });
  return c.json({ redeemCode: toRedeemCodeManagementView(code) }, 201);
});

// Create Batch Redeem Codes
redeemRouter.post(`${redeemCodesBase}/batch`, async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const body = await c.req.json<any>();
  const codes = await deps.staffRedeemCommands.createRedeemCodeBatch({
    prefix: body.prefix,
    presentId: body.presentId,
    activeAt: body.activeAt ? new Date(body.activeAt) : null,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    maxUseCount: body.maxUseCount,
    count: body.count,
  });
  return c.json({
    redeemCodes: codes.map((code) => toRedeemCodeManagementView(code)),
  });
});

// Revoke Redeem Code
redeemRouter.post(`${redeemCodesBase}/:codeId/revoke`, async (c) => {
  const shop = getShop(c);
  await staffPrincipal(c, shop);
  const deps = getShopDeps(c);
  const code = await deps.staffRedeemCommands.revokeRedeemCode({ codeId: c.req.param("codeId") });
  return c.json({ redeemCode: toRedeemCodeManagementView(code) });
});

  return redeemRouter;
}

export const redeemRouter = createRedeemRouter();
export const staffRedeemCompatRouter = createRedeemRouter("/redeem-codes");
