import type { Context } from "hono";
import type { AppBindings, TenantShop } from "../../../bindings.js";
import { getShop } from "../../../middleware/tenant.js";
import { enforceRateLimits as sharedEnforceRateLimits } from "../../../middleware/rate-limit.js";
import { jsonError } from "../../../http.js";

export type BillingShop = TenantShop;
export { staffPrincipal } from "../../../middleware/auth.js";

export async function getBillingShop(c: Context<AppBindings>, shopCode: string): Promise<BillingShop> {
  const shop = getShop(c);
  if (shopCode !== shop.public_id && shopCode !== shop.id)
    jsonError(404, "店铺不存在", "SHOP_NOT_FOUND");
  return shop;
}

/** Preserve production fail-closed transfer rate limiting. */
export async function enforceRateLimits(
  c: Context<AppBindings>, rules: Array<{key: string; limit: 3|5|10|20|30|60; windowSeconds: 60}>,
): Promise<void> {
  for (const rule of rules) {
    if (!c.env[`RATE_LIMIT_${rule.limit}` as keyof AppBindings["Bindings"]])
      jsonError(503, "限流服务尚未配置", "RATE_LIMIT_UNAVAILABLE");
  }
  await sharedEnforceRateLimits(c, rules);
}
