import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import { ensureD1UtcPricing } from "@prism/runtime";
import { migrateShopLocationTimeZones } from "../src/location-time-zone";

test("existing store zones migrate atomically from their location after UTC pricing, and retries are idempotent", async () => {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}",
    d1Databases: ["DB"], compatibilityDate: "2026-06-07" });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    for (const sql of sqliteSchema) await db.prepare(sql).run();
    const platform = readFileSync(new URL("../../../migrations/0017_platform_accounts.sql", import.meta.url), "utf8");
    for (const sql of platform.split(";").filter(s => s.trim())) await db.prepare(sql).run();
    await db.prepare("INSERT INTO users(id,role) VALUES ('owner','user')").run();
    for (const [id, latitude, longitude] of [["tokyo", 35.6812, 139.7671], ["ny", 40.7128, -74.0060]] as const) {
      await db.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?, ?,?,80,'owner')")
        .bind(id, id, id, latitude, longitude).run();
      await db.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'store.profile',?,'2026-01-01')")
        .bind(id, JSON.stringify({ name: id, timeZone: "Asia/Shanghai", extra: "preserved" })).run();
      await db.prepare(`INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
        VALUES (?,'entry','time.priority','入场',1,'active',?,'2026-01-01','2026-01-01')`)
        .bind(id, JSON.stringify({ id: "entry", timeZone: "Asia/Shanghai", rules: [{ id: "day", priority: 0,
          timeRange: { start: "10:00", end: "03:00" }, pricing: { unitMinutes: 60, unitPrice: 1800, roundGraceMinutes: 10, priceCap: 9000 } }] })).run();
    }
    await ensureD1UtcPricing(db);
    const pricing = await db.prepare("SELECT * FROM pricing_configs ORDER BY shop_id,id").all();
    const releases = await db.prepare("SELECT * FROM pricing_releases ORDER BY shop_id,id").all();
    const profiles = await db.prepare("SELECT * FROM app_settings ORDER BY shop_id,key").all();
    await db.prepare("CREATE TRIGGER fail_geo_zone BEFORE INSERT ON app_settings WHEN NEW.key='store.profile' AND NEW.shop_id='tokyo' BEGIN SELECT RAISE(ABORT,'test zone failure'); END").run();
    await expect(migrateShopLocationTimeZones(db)).rejects.toThrow();
    expect((await db.prepare("SELECT * FROM app_settings ORDER BY shop_id,key").all()).results).toEqual(profiles.results);
    expect(await db.prepare("SELECT id FROM prism_data_migrations WHERE id='shop-location-time-zone-v1'").first()).toBeNull();
    await db.prepare("DROP TRIGGER fail_geo_zone").run();
    await migrateShopLocationTimeZones(db);
    for (const [id, timeZone] of [["tokyo", "Asia/Tokyo"], ["ny", "America/New_York"]]) {
      const profile = await db.prepare("SELECT value_json FROM app_settings WHERE shop_id=? AND key='store.profile'").bind(id).first<string>("value_json");
      expect(JSON.parse(profile!)).toEqual({ name: id, timeZone, extra: "preserved" });
    }
    expect((await db.prepare("SELECT * FROM pricing_configs ORDER BY shop_id,id").all()).results).toEqual(pricing.results);
    expect((await db.prepare("SELECT * FROM pricing_releases ORDER BY shop_id,id").all()).results).toEqual(releases.results);
    const after = await db.prepare("SELECT * FROM app_settings ORDER BY shop_id,key").all();
    expect(await migrateShopLocationTimeZones(db)).toEqual({ applied: false, shops: 0 });
    expect((await db.prepare("SELECT * FROM app_settings ORDER BY shop_id,key").all()).results).toEqual(after.results);
  } finally {
    await mf.dispose();
  }
});
