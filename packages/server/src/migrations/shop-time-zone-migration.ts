import type { D1DatabaseLike } from "@prism/adapter-d1";
import { resolveLocationTimeZone } from "@prism/core";
import { shopTimeZoneStatement } from "../routes/platform/shops.js";

export const shopLocationTimeZoneMigrationId = "shop-location-time-zone-v1";
const migrations = new WeakMap<object, Promise<unknown>>();

/** Runs after the UTC pricing migration so correcting UI zones cannot shift legacy billing. */
export async function migrateShopLocationTimeZones(db: D1DatabaseLike): Promise<{
  applied: boolean;
  shops: number;
}> {
  if (
    await db
      .prepare("SELECT id FROM prism_data_migrations WHERE id=?")
      .bind(shopLocationTimeZoneMigrationId)
      .first()
  ) {
    return { applied: false, shops: 0 };
  }
  const shops = await db
    .prepare("SELECT id,latitude,longitude FROM shops")
    .bind()
    .all<{ id: string; latitude: number; longitude: number }>();
  await db.batch([
    ...shops.results.map((shop) =>
      shopTimeZoneStatement(
        db,
        shop.id,
        resolveLocationTimeZone(shop.latitude, shop.longitude),
        shop,
      ),
    ),
    db
      .prepare(
        "INSERT OR IGNORE INTO prism_data_migrations(id,applied_at) VALUES (?,?)",
      )
      .bind(shopLocationTimeZoneMigrationId, new Date().toISOString()),
  ]);
  return { applied: true, shops: shops.results.length };
}

export function ensureShopLocationTimeZones(db: D1DatabaseLike): Promise<unknown> {
  const existing = migrations.get(db);
  if (existing) return existing;
  const migration = migrateShopLocationTimeZones(db).catch((error) => {
    migrations.delete(db);
    throw error;
  });
  migrations.set(db, migration);
  return migration;
}
