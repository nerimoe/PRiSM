import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { sqliteSchema } from "@prism/storage-sql";
import { centsOf, type PricingConfig } from "@prism/core";
import { RuntimeRepositories, createPrismRuntimeDependencies } from "../src";
import { pricingVersionSchema } from "../../storage-sql/src/pricing-version-schema";
import { readFileSync } from "node:fs";

test("visits pin immutable plan versions, cap relationships and timezone across edits and SQL admission", async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  for (const sql of sqliteSchema) db.run(sql);
  let clock = new Date("2026-09-22T09:00:00Z");
  const now = () => clock, id = () => crypto.randomUUID();
  const repositories = RuntimeRepositories.fromBunSqlite({ db, shopId: "shop", now, id });
  const deps = createPrismRuntimeDependencies({ repositories, queries: RuntimeRepositories.queriesFromBunSqlite({ db, shopId: "shop", now }), now, id, pricingProviders: [], assetEffectProviders: [], coinCooldownMs: 0 });
  for (const player of ["old", "new"]) {
    db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop',?,?,'active',?)", [player,player,clock.toISOString()]);
    db.run("INSERT OR IGNORE INTO asset_definitions(shop_id,type,code,name,stackable) VALUES('shop','currency','balance','Balance',1)");
    db.run("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES('shop',?,?,'currency','balance',100000)", [player,player]);
  }
  await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Tokyo" });
  const rate: PricingConfig = { id: "rate", kind: "time.priority", name: "Old rate", enabled: true, status: "active", createdAt: clock, updatedAt: clock,
    provider: { id: "provider", rules: [{ id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 10, roundGraceMinutes: 0, priceCap: 1000 } }] } };
  const cap: PricingConfig = { id: "cap", kind: "time.cap", name: "Old cap", enabled: true, status: "active", createdAt: clock, updatedAt: clock,
    provider: { id: "cap-provider", includedPricingConfigIds: ["rate"], rules: [{ id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: 15 }] } };
  await repositories.pricingConfigs.save(rate);
  await repositories.pricingConfigs.save(cap);
  const firstVersion = (await repositories.pricingConfigs.findById("rate"))!;
  expect(firstVersion.versionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await repositories.pricingConfigs.save(rate);
  expect((await repositories.pricingConfigs.findById("rate"))?.versionId).toBe(firstVersion.versionId);
  const old = await deps.playerCommands.startSession({ playerId: "old", pricingConfigIds: ["rate"], label: "entry" });
  const release = await repositories.pricingConfigs.findRelease!(old.pricingReleaseId!);
  expect(release?.timeZone).toBe("Asia/Tokyo");
  expect(release?.configs.map(config => config.versionId)).toContain(firstVersion.versionId!);

  rate.name = "New rate"; rate.provider.rules[0]!.pricing.unitPrice = 30;
  cap.name = "New cap"; cap.provider.rules[0]!.priceCap = 50;
  await repositories.pricingConfigs.save(rate);
  await repositories.pricingConfigs.save(cap);
  await repositories.system.setAppSetting("store.profile", { timeZone: "America/New_York" });
  const latest = (await repositories.pricingConfigs.findById("rate"))!;
  expect(latest.version).toBe(2);
  expect(latest.versionId).not.toBe(firstVersion.versionId);
  expect((await repositories.pricingConfigs.findRelease!(old.pricingReleaseId!))?.configs.find(config => config.id === "rate")?.name).toBe("Old rate");
  const fresh = await deps.playerCommands.startSession({ playerId: "new", pricingConfigIds: ["rate"], label: "entry" });
  expect(fresh.pricingReleaseId).not.toBe(old.pricingReleaseId);

  await repositories.pricingConfigs.save({ ...rate, id: "added" });
  await expect(deps.playerCommands.startSession({ playerId: "old", pricingConfigIds: ["added"] })).rejects.toThrow();
  expect(() => db.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES('shop','rejected','old',?,'active','unpaid','[\"added\"]')", [clock.toISOString()])).toThrow("PRICING_CONFIG_NOT_IN_RELEASE");
  expect(await repositories.sessions.findById("rejected")).toBeNull();

  // Mahjong's SQL-only insert must join the same publication as the open visit.
  db.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json,label) VALUES('shop','table','old',?,'active','unpaid','[\"rate\"]','table')", [clock.toISOString()]);
  expect((await repositories.sessions.findById("table"))?.pricingReleaseId).toBe(old.pricingReleaseId);
  clock = new Date("2026-09-22T11:00:00Z");
  const oldPreview = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "old" });
  const newPreview = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "new" });
  expect(oldPreview.settlementPreview.total).toBe(centsOf(15));
  expect(newPreview.settlementPreview.total).toBe(centsOf(50));
  expect(oldPreview.chargeItems.every(item => item.source === "provider")).toBe(true);
  expect(newPreview.chargeItems.every(item => item.source === latest.versionId)).toBe(true);
  await repositories.pricingConfigs.save({ ...rate, enabled: false, status: "archived" });
  await repositories.pricingConfigs.save({ ...cap, enabled: false, status: "archived" });
  expect((await deps.playerCheckoutCommands!.previewCheckout({ playerId: "old" })).settlementPreview.total).toBe(centsOf(15));
  const checkout = await deps.playerCheckoutCommands!.checkout({ playerId: "old", closeSessionsBeforeBalanceCheck: false });
  expect(checkout.playerSettlement.total).toBe(centsOf(15));
  const receipt = await deps.playerQueries.getLatestPlayerCheckout!("old");
  expect(receipt?.timeline.pricingReleaseIds).toEqual([old.pricingReleaseId!]);
  expect(receipt?.timeline.totals.some(row => row.name === "Old cap（Day）")).toBe(true);
  expect(receipt?.timeline.tracks.every(track => track.name === "Old rate")).toBe(true);
  const other = RuntimeRepositories.fromBunSqlite({ db, shopId: "other", now, id });
  expect(await other.pricingConfigs.findRelease!(old.pricingReleaseId!)).toBeNull();
  expect(() => db.run("UPDATE pricing_config_versions SET name='tampered'")).toThrow("immutable");
  expect(() => db.run("DELETE FROM pricing_releases")).toThrow("immutable");
  expect(() => db.run("UPDATE session_pricing_releases SET release_id=?", [fresh.pricingReleaseId!])).toThrow("immutable");
  db.close();
});

test("migration pins only unpaid visits, preserves cumulative caps and rolls publication back atomically", async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  for (const sql of sqliteSchema.slice(0, -pricingVersionSchema.length)) db.run(sql);
  const at = "2026-09-22T09:00:00.000Z";
  db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop','player','Player','active',?)", [at]);
  // SQL stores money in cents, unlike the management provider representation.
  const rate = { id: "provider", rules: [{ id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 1000, roundGraceMinutes: 0, priceCap: 1500 } }] };
  const cap = { id: "cap-provider", includedPricingConfigIds: ["rate"], rules: [{ id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: 1200 }] };
  for (const [id, kind, provider] of [["rate", "time.priority", rate], ["cap", "time.cap", cap]] as const) {
    db.run("INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at) VALUES('shop',?,?,?,1,'active',?,?,?)", [id, kind, id, JSON.stringify(provider), at, at]);
  }
  for (const [id, status, payment] of [["open", "active", "unpaid"], ["paid", "closed", "paid"]]) {
    db.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES('shop',?,'player',?,?,?,'[\"rate\"]')", [id!, at, status!, payment!]);
  }
  db.run("INSERT INTO pricing_history_entries(shop_id,id,player_id,pricing_config_id,provider_id,rule_id,rule_anchor_at,session_id,amount,created_at) VALUES('shop','history','player','rate','provider','day','2026-09-22T00:00:00.000Z','paid',1000,?)", [at]);
  db.run("INSERT INTO pricing_cap_history_entries(shop_id,id,player_id,cap_config_id,cap_rule_id,cap_anchor_at,included_pricing_config_ids_json,session_ids_json,amount,created_at) VALUES('shop','cap-history','player','cap','day','2026-09-22T00:00:00.000Z','[\"rate\"]','[\"paid\"]',1000,?)", [at]);
  const migration = readFileSync(new URL("../../../migrations/0028_pricing_versions.sql", import.meta.url), "utf8");
  expect(migration.trim()).toBe((pricingVersionSchema.join(";\n\n") + ";").trim());
  db.exec(migration);
  const now = () => new Date("2026-09-22T10:00:00.000Z"), id = () => crypto.randomUUID();
  const repositories = RuntimeRepositories.fromBunSqlite({ db, shopId: "shop", now, id });
  const open = (await repositories.sessions.findById("open"))!;
  expect(open.pricingReleaseId).toBeString();
  expect((await repositories.sessions.findById("paid"))?.pricingReleaseId).toBeUndefined();
  for (const sql of sqliteSchema) db.run(sql);
  expect((await repositories.sessions.findById("open"))?.pricingReleaseId).toBe(open.pricingReleaseId);
  const deps = createPrismRuntimeDependencies({ repositories, queries: RuntimeRepositories.queriesFromBunSqlite({ db, shopId: "shop", now }), now, id, pricingProviders: [], assetEffectProviders: [], coinCooldownMs: 0 });
  const preview = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "player" });
  expect(preview.chargeItems.reduce((sum, item) => sum + item.amount, 0)).toBe(centsOf(5));
  expect(preview.settlementPreview.total).toBe(centsOf(2));
  const head = db.query("SELECT * FROM pricing_release_heads").all();
  expect(() => db.transaction(() => {
    db.run("UPDATE pricing_configs SET name='changed'");
    throw new Error("rollback");
  })()).toThrow("rollback");
  expect(db.query("SELECT * FROM pricing_release_heads").all()).toEqual(head);
  expect((await repositories.pricingConfigs.findById("rate"))?.version).toBe(1);
  db.close();
});
