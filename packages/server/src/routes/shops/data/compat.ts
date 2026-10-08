import type { D1DatabaseLike, D1BoundStatementLike } from "@prism/adapter-d1";
import type { AppBindings as ServerBindings } from "../../../bindings.js";
import { staffPrincipal as serverStaffPrincipal } from "../../../middleware/auth.js";
import type { Context } from "hono";
import type { TenantShop } from "../../../bindings.js";
import { getShop } from "../../../middleware/tenant.js";
import { enforceRateLimits as sharedEnforceRateLimits } from "../../../middleware/rate-limit.js";
import { jsonError } from "../../../http.js";

export type BillingShop = TenantShop;


export async function getBillingShop(c: Context<AppBindings>, shopCode: string): Promise<BillingShop> {
  const shop = getShop(c as unknown as Context<ServerBindings>);
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
  await sharedEnforceRateLimits(c as unknown as Context<ServerBindings>, rules);
}

export type LegacyD1Result<T> = { results: T[]; meta: { changes: number } };
export type LegacyD1PreparedStatement = D1BoundStatementLike & {
  bind(...values: any[]): LegacyD1PreparedStatement;
  first<T=unknown>(columnName?: string): Promise<T|null>;
  all<T=unknown>(): Promise<LegacyD1Result<T>>;
  run(): Promise<{meta:{changes:number}}>;
};
export type LegacyD1Database = D1DatabaseLike & {
  prepare(sql: string): LegacyD1PreparedStatement;
  batch<T=unknown>(statements: readonly D1BoundStatementLike[]): Promise<Array<LegacyD1Result<T>>>;
};
export type AppBindings = {
  Bindings: Omit<ServerBindings["Bindings"],"DB"> & {DB:LegacyD1Database};
  Variables: ServerBindings["Variables"];
};
export async function staffPrincipal(c: Context<AppBindings>, shop: TenantShop, readOnly = false) {
  return serverStaffPrincipal(c as unknown as Context<ServerBindings>,shop,readOnly);
}
