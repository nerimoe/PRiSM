import type { Context } from "hono";
import type { AppBindings, AuthUser, MachineRow, ShopRow } from "./types";

export async function canAccessShop(c: Context<AppBindings>, user: AuthUser, shopId: string): Promise<boolean> {
  if (user.role === "admin") return true;
  const row = await c.env.DB.prepare("SELECT id FROM shop_members WHERE shop_id = ? AND user_id = ?")
    .bind(shopId, user.id)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function listShopsForUser(c: Context<AppBindings>, user: AuthUser): Promise<ShopRow[]> {
  if (user.role === "admin") {
    return (
      await c.env.DB.prepare(
        "SELECT id, public_id AS publicId, name, CASE WHEN hero_data IS NULL OR hero_data = '' THEN NULL ELSE '/api/v1/shops/' || public_id || '/hero?v=' || COALESCE(hero_hash, 'original') END AS heroUrl, latitude, longitude, radius_meters, created_by FROM shops ORDER BY created_at DESC",
      ).all<ShopRow>()
    ).results;
  }
  return (
    await c.env.DB.prepare(
      `SELECT shops.id, shops.public_id AS publicId, shops.name,
              CASE WHEN shops.hero_data IS NULL OR shops.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || shops.public_id || '/hero?v=' || COALESCE(shops.hero_hash, 'original') END AS heroUrl,
              shops.latitude, shops.longitude,
              shops.radius_meters, shops.created_by
       FROM shops
       JOIN shop_members ON shop_members.shop_id = shops.id
       WHERE shop_members.user_id = ?
       ORDER BY shops.created_at DESC`,
    )
      .bind(user.id)
      .all<ShopRow>()
  ).results;
}

export async function getMachineByPublicId(db: D1Database, publicId: string): Promise<MachineRow | null> {
  return db
    .prepare(
      `SELECT machines.*, shops.name AS shop_name,
              CASE WHEN shops.hero_data IS NULL OR shops.hero_data = '' THEN NULL ELSE '/api/v1/shops/' || shops.public_id || '/hero?v=' || COALESCE(shops.hero_hash, 'original') END AS shop_hero_url,
              shops.latitude, shops.longitude, shops.radius_meters
              , shops.public_id AS shop_public_id, (COALESCE(b.machine_geo,0) OR COALESCE(b.checkin_geo,0) OR COALESCE(b.checkout_geo,0)) AS machine_geo, COALESCE(b.billing_enabled,0) AS billing_enabled
       FROM machines
       JOIN shops ON shops.id = machines.shop_id
       LEFT JOIN shop_billing_settings b ON b.shop_id=shops.id
       WHERE machines.public_id = ?`,
    )
    .bind(publicId)
    .first<MachineRow>();
}
