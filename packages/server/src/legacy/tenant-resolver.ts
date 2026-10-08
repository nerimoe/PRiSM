import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings, TenantShop } from "../bindings.js";
import { jsonError } from "../http.js";
import { getOrCreateShopDependencies } from "../middleware/tenant.js";

/**
 * Normalizes shop record by ensuring numerical boolean representation for geo flags.
 */
export function normalizeShop(shopRow: TenantShop): TenantShop {
  const enabled = +(!!(
    shopRow.checkin_geo ||
    shopRow.checkout_geo ||
    shopRow.machine_geo
  ));
  return {
    ...shopRow,
    checkin_geo: enabled,
    checkout_geo: enabled,
    machine_geo: enabled,
  };
}

/**
 * Resolves the target tenant shop for legacy single-store requests:
 * 1. Checks `X-PRiSM-Shop-Code` request header
 * 2. Checks `?shopCode=...` query parameter
 * 3. Checks environment variables (`DEFAULT_SHOP_CODE`)
 * 4. Fallback: queries the database for 'default' shop or the first active/created shop.
 */
export async function resolveLegacyShop(
  c: Context<AppBindings>,
): Promise<TenantShop | null> {
  const shopCode =
    c.req.header("X-PRiSM-Shop-Code")?.trim() ||
    c.req.query("shopCode")?.trim() ||
    (c.env as any)?.DEFAULT_SHOP_CODE ||
    (typeof process !== "undefined" ? process.env?.DEFAULT_SHOP_CODE : undefined);

  if (shopCode) {
    const shopRow = await c.env.DB.prepare(
      `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
        COALESCE(b.billing_enabled, 0) AS billing_enabled,
        COALESCE(b.auto_register, 0) AS auto_register,
        COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
        COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
        COALESCE(b.checkin_geo, 0) AS checkin_geo,
        COALESCE(b.checkout_geo, 0) AS checkout_geo,
        COALESCE(b.machine_geo, 0) AS machine_geo,
        COALESCE(b.entry_pricing_ids_json, '[]') AS entry_pricing_ids_json,
        COALESCE(b.bot_contact, '') AS bot_contact,
        CASE WHEN s.hero_data IS NULL OR s.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || s.public_id || '/hero?v=' || COALESCE(s.hero_hash, 'original') END AS hero_url,
        COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = s.id AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone
      FROM shops s
      LEFT JOIN shop_billing_settings b ON b.shop_id = s.id
      WHERE s.public_id = ? OR s.id = ?`,
    )
      .bind(shopCode, shopCode)
      .first<TenantShop>();

    if (shopRow) {
      return normalizeShop(shopRow);
    }
  }

  // Fallback to default or first shop in the database
  const fallbackRow = await c.env.DB.prepare(
    `SELECT s.id, s.public_id, s.name, s.latitude, s.longitude, s.radius_meters,
      COALESCE(b.billing_enabled, 0) AS billing_enabled,
      COALESCE(b.auto_register, 0) AS auto_register,
      COALESCE(b.identity_binding_required, 1) AS identity_binding_required,
      COALESCE((SELECT json_extract(value_json, '$.enabled') FROM app_settings WHERE shop_id = s.id AND key = 'cashier.settings'), 0) AS cashier_enabled,
      COALESCE(b.checkin_geo, 0) AS checkin_geo,
      COALESCE(b.checkout_geo, 0) AS checkout_geo,
      COALESCE(b.machine_geo, 0) AS machine_geo,
      COALESCE(b.entry_pricing_ids_json, '[]') AS entry_pricing_ids_json,
      COALESCE(b.bot_contact, '') AS bot_contact,
      CASE WHEN s.hero_data IS NULL OR s.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || s.public_id || '/hero?v=' || COALESCE(s.hero_hash, 'original') END AS hero_url,
      COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = s.id AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone
    FROM shops s
    LEFT JOIN shop_billing_settings b ON b.shop_id = s.id
    ORDER BY CASE WHEN s.public_id = 'default' OR s.id = 'default' THEN 0 ELSE 1 END, s.created_at ASC
    LIMIT 1`,
  ).bind().first<TenantShop>();

  return fallbackRow ? normalizeShop(fallbackRow) : null;
}

/**
 * Middleware that resolves tenant context for legacy single-store endpoints and injects dependencies.
 */
export const legacyTenantMiddleware: MiddlewareHandler<AppBindings> = async (
  c,
  next,
) => {
  const shop = await resolveLegacyShop(c);

  if (!shop) {
    // Setup routes may run before any shop exists in the database
    if (c.req.path.includes("/setup")) {
      await next();
      return;
    }
    jsonError(404, "未找到目标店铺，请指定店铺代码或先创建店铺", "SHOP_NOT_FOUND");
  }

  c.set("shop", shop);
  c.set("responseTimeZone", shop.time_zone);

  const deps = getOrCreateShopDependencies(c.env.DB, shop);
  c.set("deps", deps);

  await next();
};
