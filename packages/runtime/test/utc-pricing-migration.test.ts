import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { centsOf, type PricingConfig } from "@prism/core";
import { createBunSqliteExecutor } from "@prism/adapter-sqlite";
import { migrateLegacyPricingToUtc, serializePricingProviderConfig, sqliteSchema, utcPricingMigrationId } from "@prism/storage-sql";
import { utcPricingSchema } from "../../storage-sql/src/utc-pricing-schema";
import { pricingVersionSchema } from "../../storage-sql/src/pricing-version-schema";
import { createPrismRuntimeDependencies, RuntimeRepositories } from "../src";

function legacyDb() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  for (const sql of sqliteSchema.filter(sql => !(utcPricingSchema as readonly string[]).includes(sql))) db.run(sql);
  return db;
}
function rows(db: Database) {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
}
function runtime(db: Database, now: () => Date, shopId = "shop") {
  const repositories = RuntimeRepositories.fromBunSqlite({ db, shopId, now, id: () => crypto.randomUUID() });
  return { repositories, deps: createPrismRuntimeDependencies({ repositories, queries: RuntimeRepositories.queriesFromBunSqlite({ db, shopId, now }), now, id: () => crypto.randomUUID(), pricingProviders: [], assetEffectProviders: [], coinCooldownMs: 0 }) };
}
function player(db: Database, id: string) {
  db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop',?,?,'active','2026-01-01T00:00:00Z')", [id, id]);
}
function plan(at: Date): PricingConfig {
  return { id: "rate", kind: "time.priority", name: "Rate", enabled: true, status: "active", createdAt: at, updatedAt: at,
    provider: { id: "provider", rules: [{ id: "base", label: "Base", priority: 1, timeRange: { start: "10:00", end: "03:00" }, pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 } }] } };
}
function saveLegacyPlan(db: Database, config: PricingConfig) {
  // Seed the actual old SQL representation, not the new writer's UTC default.
  db.run(`INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
    VALUES('shop',?,?,?,1,'active',json_remove(?,'$.timeZone'),?,?)`,
    [config.id, config.kind, config.name, JSON.stringify(serializePricingProviderConfig(config.provider)),
      config.createdAt.toISOString(), config.updatedAt.toISOString()]);
}

test("explicit legacy provider zones override release zones for rates and caps, including already UTC rules", async () => {
  for (const [sourceZone, expectedStart, expectedEnd] of [["Asia/Tokyo", "01:00", "18:00"], ["UTC", "10:00", "03:00"]]) {
    const db = legacyDb(), at = new Date("2026-10-02T12:00:00Z");
    const { repositories } = runtime(db, () => at);
    await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Shanghai" });
    const rate = plan(at);
    if (rate.kind !== "time.priority") throw new Error("type");
    rate.provider.timeZone = sourceZone;
    await repositories.pricingConfigs.save(rate);
    await repositories.pricingConfigs.save({ id: "cap", kind: "time.cap", name: "Cap", enabled: true,
      createdAt: at, updatedAt: at, provider: { id: "cap", timeZone: sourceZone,
        includedPricingConfigIds: ["rate"], rules: [{ id: "cap-day", label: "Cap", priority: 1,
          timeRange: { start: "10:00", end: "03:00" }, priceCap: 90 }] } });
    expect(db.query("SELECT DISTINCT time_zone FROM pricing_releases").all()).toEqual([{ time_zone: "Asia/Shanghai" }]);
    for (const sql of utcPricingSchema) db.run(sql);
    await migrateLegacyPricingToUtc({ executor: createBunSqliteExecutor(db), now: at, id: () => crypto.randomUUID() });
    for (const table of ["pricing_configs", "pricing_config_versions"]) {
      const providers = db.query(`SELECT provider_json FROM ${table}`).all() as { provider_json: string }[];
      for (const row of providers) expect(JSON.parse(row.provider_json)).toMatchObject({ timeZone: "UTC",
        rules: [{ timeRange: { start: expectedStart, end: expectedEnd } }] });
    }
    db.close();
  }
});

test("pre-versioning databases capture the old operations zone before UTC conversion", async () => {
  const db = new Database(":memory:"), at = new Date("2026-10-02T12:00:00Z");
  db.run("PRAGMA foreign_keys=ON");
  for (const sql of sqliteSchema.filter(sql => !(utcPricingSchema as readonly string[]).includes(sql)
    && !(pricingVersionSchema as readonly string[]).includes(sql))) db.run(sql);
  const { repositories } = runtime(db, () => at);
  await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Tokyo" });
  await repositories.system.setAppSetting("venue.operations", { timeZone: "Asia/Shanghai" });
  saveLegacyPlan(db, plan(at));
  for (const sql of pricingVersionSchema) db.run(sql);
  expect(db.query("SELECT time_zone FROM pricing_releases").all()).toEqual([{ time_zone: "Asia/Shanghai" }]);
  for (const sql of utcPricingSchema) db.run(sql);
  await migrateLegacyPricingToUtc({ executor: createBunSqliteExecutor(db), now: at, id: () => crypto.randomUUID() });
  expect((await repositories.pricingConfigs.findById("rate"))?.provider).toMatchObject({ timeZone: "UTC",
    rules: [{ timeRange: { start: "02:00", end: "19:00" } }] });
  expect(await repositories.system.getAppSetting<{ timeZone: string }>("venue.operations")).toEqual({ timeZone: "UTC" });
  expect(await repositories.system.getAppSetting<{ timeZone: string }>("store.profile")).toEqual({ timeZone: "Asia/Tokyo" });
  db.close();
});

test("different release timezones sharing one version migrate without changing fees, identities or snapshots twice", async () => {
  const db = legacyDb();
  let clock = new Date("2026-10-02T17:00:00Z");
  const { repositories, deps } = runtime(db, () => clock);
  player(db, "shanghai"); player(db, "tokyo");
  await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Shanghai" });
  saveLegacyPlan(db, plan(clock));
  await repositories.pricingConfigs.save({ id: "fixed", kind: "charge.fixed", name: "Entry", enabled: true, status: "active", createdAt: clock, updatedAt: clock, provider: { id: "entry", label: "Entry", amount: 6 } });
  const a = await deps.playerCommands.startSession({ playerId: "shanghai", pricingConfigIds: ["rate", "fixed"] });
  await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Tokyo" });
  const b = await deps.playerCommands.startSession({ playerId: "tokyo", pricingConfigIds: ["rate", "fixed"] });
  clock = new Date("2026-10-02T18:30:00Z");
  const beforeA = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "shanghai" });
  const beforeB = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "tokyo" });
  expect(beforeA.settlementPreview.total).toBe(centsOf(42));
  expect(beforeB.settlementPreview.total).toBe(centsOf(24));
  db.run("INSERT INTO player_checkouts(shop_id,id,player_id,subtotal,total,status,settled_at) VALUES('shop','paid','shanghai',1800,1800,'settled','2026-10-02T16:00:00Z')");
  const snapshot = { amount: 18, pricingExplanation: { timeZone: "Asia/Shanghai", ruleTimeRange: { start: "10:00", end: "03:00" }, period: { startedAt: "2026-10-02T15:00:00Z", endedAt: "2026-10-02T16:00:00Z" } }, events: [{ at: "2026-10-02T16:00:00Z", time: "00:00", date: "2026-10-03", entries: [] }] };
  db.run("INSERT INTO checkout_timelines(shop_id,checkout_id,timeline_json) VALUES('shop','paid',?)", [JSON.stringify(snapshot)]);
  const totals = db.query("SELECT * FROM player_checkouts").all();
  const bindings = db.query("SELECT * FROM session_pricing_releases ORDER BY session_id").all();
  for (const sql of utcPricingSchema) db.run(sql);
  const input = { executor: createBunSqliteExecutor(db), now: clock, id: () => crypto.randomUUID() };
  expect((await migrateLegacyPricingToUtc(input)).applied).toBe(true);
  const afterA = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "shanghai" });
  const afterB = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "tokyo" });
  expect(afterA.settlementPreview.total).toBe(beforeA.settlementPreview.total);
  expect(afterB.settlementPreview.total).toBe(beforeB.settlementPreview.total);
  expect(afterA.chargeItems.map(item => [item.amount, item.pricingHistory, item.period])).toEqual(beforeA.chargeItems.map(item => [item.amount, item.pricingHistory, item.period]));
  expect(afterB.chargeItems.map(item => [item.amount, item.pricingHistory, item.period])).toEqual(beforeB.chargeItems.map(item => [item.amount, item.pricingHistory, item.period]));
  expect(db.query("SELECT * FROM player_checkouts").all()).toEqual(totals);
  expect(db.query("SELECT * FROM session_pricing_releases ORDER BY session_id").all()).toEqual(bindings);
  expect((await repositories.pricingConfigs.findRelease!(a.pricingReleaseId!))?.timeZone).toBe("UTC");
  expect((await repositories.pricingConfigs.findRelease!(b.pricingReleaseId!))?.timeZone).toBe("UTC");
  expect(db.query("SELECT time_zone FROM pricing_releases WHERE time_zone!='UTC'").all()).toEqual([]);
  expect(db.query("SELECT provider_json FROM pricing_config_versions WHERE kind!='charge.fixed' AND json_extract(provider_json,'$.timeZone') IS NOT 'UTC'").all()).toEqual([]);
  expect(await repositories.system.getAppSetting<{ timeZone: string }>("store.profile")).toEqual({ timeZone: "Asia/Tokyo" });
  const converted = JSON.parse((db.query("SELECT timeline_json FROM checkout_timelines").get() as { timeline_json: string }).timeline_json);
  expect(converted.amount).toBe(18);
  expect(converted.pricingExplanation.timeZone).toBe("UTC");
  expect(converted.pricingExplanation.ruleTimeRange).toEqual({ start: "02:00", end: "19:00" });
  expect(converted.events[0]).toMatchObject({ date: "2026-10-02", time: "16:00" });
  const once = rows(db);
  expect((await migrateLegacyPricingToUtc({ ...input, now: new Date("2027-10-02T18:30:00Z") })).applied).toBe(false);
  expect(rows(db)).toEqual(once);
  expect(() => db.run("UPDATE pricing_releases SET time_zone='Asia/Shanghai'")).toThrow("immutable");
  db.close();
});

test("historical DST calendars and cumulative caps keep UTC anchors and paid amounts", async () => {
  const db = legacyDb();
  let clock = new Date("2026-01-01T00:00:00Z");
  const { repositories, deps } = runtime(db, () => clock);
  await repositories.system.setAppSetting("store.profile", { timeZone: "America/New_York" });
  const rate = plan(clock);
  if (rate.kind !== "time.priority") throw new Error("type");
  rate.provider.rules = [{ ...rate.provider.rules[0]!, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 0, priceCap: 90 } }];
  saveLegacyPlan(db, rate);
  for (const [id, start, end] of [["winter", "2026-01-02T05:00:00Z", "2026-01-02T08:00:00Z"], ["summer", "2026-07-02T04:00:00Z", "2026-07-02T07:00:00Z"], ["spring", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"]]) {
    player(db, id!);
    db.run("INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status,payment_status,pricing_config_ids_json) VALUES('shop',?,?,?,?,'closed','unpaid','[\"rate\"]')", [id!, id!, start!, end!]);
  }
  clock = new Date("2026-10-02T12:00:00Z");
  const before = await Promise.all(["winter", "summer", "spring"].map(playerId => deps.playerCheckoutCommands!.previewCheckout({ playerId })));
  expect(before.map(p => p.settlementPreview.total)).toEqual([centsOf(54), centsOf(54), centsOf(90)]);
  db.run("INSERT INTO pricing_history_entries(shop_id,id,player_id,pricing_config_id,provider_id,rule_id,rule_anchor_at,session_id,amount,created_at) VALUES('shop','h','winter','rate','provider','base','2026-01-02T05:00:00.000Z','winter',8000,'2026-01-02T06:00:00.000Z')");
  const withHistory = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "winter" });
  expect(withHistory.settlementPreview.total).toBe(centsOf(10));
  expect(before[2]!.chargeItems[0]!.pricingExplanation?.units).toBe(23);
  const historyRows = db.query("SELECT * FROM pricing_history_entries").all();
  for (const sql of utcPricingSchema) db.run(sql);
  await migrateLegacyPricingToUtc({ executor: createBunSqliteExecutor(db), now: clock, id: () => crypto.randomUUID() });
  const after = await Promise.all(["winter", "summer", "spring"].map(playerId => deps.playerCheckoutCommands!.previewCheckout({ playerId })));
  expect(after[0]!.settlementPreview.total).toBe(withHistory.settlementPreview.total);
  expect(after.slice(1).map(p => p.settlementPreview.total)).toEqual(before.slice(1).map(p => p.settlementPreview.total));
  expect(after[0]!.chargeItems[0]!.pricingExplanation?.paidBefore).toBe(80);
  expect(after[2]!.chargeItems[0]!.pricingExplanation?.units).toBe(23);
  expect(after[0]!.chargeItems[0]!.pricingHistory?.ruleAnchorAt.toISOString()).toBe("2026-01-02T05:00:00.000Z");
  expect(after[1]!.chargeItems[0]!.pricingHistory?.ruleAnchorAt.toISOString()).toBe("2026-07-02T04:00:00.000Z");
  expect(db.query("SELECT * FROM pricing_history_entries").all()).toEqual(historyRows);
  expect((await repositories.pricingConfigs.findById("rate"))?.provider).toMatchObject({ timeZone: "UTC", rules: [{ timeRange: { start: "04:00", end: "04:00" } }] });
  player(db, "returning");
  const todayAnchor = "2026-10-02T04:00:00.000Z";
  db.run("INSERT INTO pricing_history_entries(shop_id,id,player_id,pricing_config_id,provider_id,rule_id,rule_anchor_at,session_id,amount,created_at) VALUES('shop','return-history','returning','rate','provider','base',?,'winter',8000,?)", [todayAnchor, clock.toISOString()]);
  await deps.playerCommands.startSession({ playerId: "returning", pricingConfigIds: ["rate"] });
  clock = new Date(clock.getTime() + 3 * 3600_000);
  expect((await deps.playerCheckoutCommands!.previewCheckout({ playerId: "returning" })).settlementPreview.total).toBe(centsOf(10));
  const once = rows(db);
  await migrateLegacyPricingToUtc({ executor: createBunSqliteExecutor(db), now: new Date("2026-12-01"), id: () => crypto.randomUUID() });
  expect(rows(db)).toEqual(once);
  db.close();
});

test("failed conversion rolls back changes and marker; concurrent retries commit only once", async () => {
  const db = legacyDb(), at = new Date("2026-10-02T12:00:00Z");
  const { repositories } = runtime(db, () => at);
  await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Shanghai" });
  saveLegacyPlan(db, plan(at));
  for (const sql of utcPricingSchema) db.run(sql);
  const executor = createBunSqliteExecutor(db), original = rows(db);
  const failing = { ...executor, batch: (statements: Parameters<typeof executor.batch>[0]) => executor.batch([...statements, { sql: "SELECT * FROM deliberately_missing_table" }]) };
  await expect(migrateLegacyPricingToUtc({ executor: failing, now: at, id: () => crypto.randomUUID() })).rejects.toThrow("deliberately_missing_table");
  expect(rows(db)).toEqual(original);
  expect(await executor.first("SELECT id FROM prism_data_migrations WHERE id=?", [utcPricingMigrationId])).toBeNull();
  expect(() => db.run("UPDATE pricing_releases SET time_zone='UTC'")).toThrow("immutable");
  const results = await Promise.all([1, 2].map(() => migrateLegacyPricingToUtc({ executor, now: at, id: () => crypto.randomUUID() })));
  expect(results.map(result => result.applied).sort()).toEqual([false, true]);
  expect(db.query("SELECT COUNT(*) AS n FROM prism_data_migrations").get()).toEqual({ n: 1 });
  db.close();
});
