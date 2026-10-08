import type { D1BoundStatementLike } from "@prism/adapter-d1";
import type { Context } from "hono";
import type { AppBindings as ServerBindings, TenantShop } from "../../../bindings.js";
import { staffPrincipal as serverStaffPrincipal } from "../../../middleware/auth.js";
import { getShop } from "../../../middleware/tenant.js";
import { enforceRateLimits as sharedEnforceRateLimits } from "../../../middleware/rate-limit.js";
import { jsonError } from "../../../http.js";

export type AppBindings = ServerBindings;
export type BillingShop = TenantShop;
export type LegacyD1Result<T> = { results: T[]; meta: { changes: number } };
export type LegacyD1PreparedStatement = {
  bind(...values: any[]): LegacyD1PreparedStatement;
  first<T=unknown>(columnName?: string): Promise<T|null>;
  all<T=unknown>(): Promise<LegacyD1Result<T>>;
  run(): Promise<{meta:{changes:number}}>;
};
export type LegacyD1Database = {
  prepare(sql: string): LegacyD1PreparedStatement;
  batch<T=unknown>(statements: readonly D1BoundStatementLike[]): Promise<Array<LegacyD1Result<T>>>;
};
export async function getBillingShop(c: Context<AppBindings, any, any>, shopCode: string): Promise<BillingShop> {
  const shop = getShop(c);
  if (shop.public_id !== shopCode && shop.id !== shopCode)
    jsonError(404,"店铺不存在","SHOP_NOT_FOUND");
  return shop;
}
export async function staffPrincipal(c: Context<AppBindings, any, any>, shop:TenantShop, readOnly=false) {
  return serverStaffPrincipal(c,shop,readOnly);
}
export async function enforceRateLimits(c:Context<AppBindings, any, any>, rules:Array<{key:string;limit:3|5|10|20|30|60;windowSeconds:60}>) {
  for(const rule of rules) {
    if(!c.env[`RATE_LIMIT_${rule.limit}` as keyof ServerBindings["Bindings"]])
      jsonError(503,"限流服务尚未配置","RATE_LIMIT_UNAVAILABLE");
  }
  await sharedEnforceRateLimits(c,rules);
}
