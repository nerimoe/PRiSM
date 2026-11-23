import { Hono } from "hono";
import { PrismDomainError } from "@prism/core";
import type { StaffRedeemCodeUsageFilter, StaffRedeemCodeValidityFilter } from "@prism/application";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { staffPrincipal } from "../../middleware/auth.js";
import { getShop, getShopDeps } from "../../middleware/tenant.js";
import {
  toPresentManagementView,
  toRedeemCodeManagementView,
} from "./views.js";

const REDEEM_CODE_USAGES = new Set<StaffRedeemCodeUsageFilter>(["unused", "partial", "exhausted", "revoked"]);
const REDEEM_CODE_VALIDITIES = new Set<StaffRedeemCodeValidityFilter>(["valid", "pending", "expired"]);

function parseOptionalRedeemDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new PrismDomainError("Invalid redeem code date.", "INVALID_REDEEM_CODE_WINDOW");
  }
  return date;
}

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

  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");
  const presentIdRaw = c.req.query("presentId");
  const usageRaw = c.req.query("usage");
  const validityRaw = c.req.query("validity");
  const searchRaw = c.req.query("search");

  const hasPaginationOrFilter = [limitRaw, offsetRaw, presentIdRaw, usageRaw, validityRaw, searchRaw].some(
    (value) => value !== undefined,
  );
  if (hasPaginationOrFilter && deps.staffRedeemQueries?.listRedeemCodesPage) {
    const limit = limitRaw !== undefined && limitRaw !== "" ? Number(limitRaw) : 30;
    const offset = offsetRaw !== undefined && offsetRaw !== "" ? Number(offsetRaw) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
      jsonError(400, "无效的兑换码筛选参数", "INVALID_REDEEM_CODE_FILTER");
    }
    const usageText = usageRaw?.trim();
    if (usageText && !REDEEM_CODE_USAGES.has(usageText as StaffRedeemCodeUsageFilter)) {
      jsonError(400, "无效的兑换码筛选参数", "INVALID_REDEEM_CODE_FILTER");
    }
    const validityText = validityRaw?.trim();
    if (validityText && !REDEEM_CODE_VALIDITIES.has(validityText as StaffRedeemCodeValidityFilter)) {
      jsonError(400, "无效的兑换码筛选参数", "INVALID_REDEEM_CODE_FILTER");
    }
    const page = await deps.staffRedeemQueries.listRedeemCodesPage({
      limit,
      offset,
      ...(presentIdRaw?.trim() ? { presentId: presentIdRaw.trim() } : {}),
      ...(usageText ? { usage: usageText as StaffRedeemCodeUsageFilter } : {}),
      ...(validityText ? { validity: validityText as StaffRedeemCodeValidityFilter } : {}),
      ...(searchRaw?.trim() ? { search: searchRaw.trim() } : {}),
    });
    const redemptionsByCodeId = new Map<string, typeof page.redemptions>();
    for (const redemption of page.redemptions) {
      const items = redemptionsByCodeId.get(redemption.codeId) ?? [];
      items.push(redemption);
      redemptionsByCodeId.set(redemption.codeId, items);
    }
    return c.json({
      redeemCodes: page.codes.map((code) =>
        toRedeemCodeManagementView(code, redemptionsByCodeId.get(code.id) ?? []),
      ),
      page: { limit, offset, total: page.total, hasMore: page.hasMore },
    });
  }

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
    code: typeof body.code === "string" ? body.code : "",
    presentId: typeof body.presentId === "string" ? body.presentId : "",
    activeAt: parseOptionalRedeemDate(body.activeAt),
    expiresAt: parseOptionalRedeemDate(body.expiresAt),
    maxUseCount: Number(body.maxUseCount),
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
    prefix: typeof body.prefix === "string" ? body.prefix : "",
    presentId: typeof body.presentId === "string" ? body.presentId : "",
    activeAt: parseOptionalRedeemDate(body.activeAt),
    expiresAt: parseOptionalRedeemDate(body.expiresAt),
    maxUseCount: Number(body.maxUseCount),
    count: Number(body.count),
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
