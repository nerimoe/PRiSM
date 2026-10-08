import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { centsOf, yuanOf, validatePricingConfig, buildPriorityTimePricingTimeline, type PricingConfig } from "../packages/core/src";
import { sqliteSchema } from "../packages/storage-sql/src";
import {
  createD1DatabaseFromSqlite,
  createShopDependencies,
  type TenantShop,
} from "../packages/server/src";
import { buildBillTimeline } from "../packages/application/src/bill-timeline";

// Diagnostic only: all data stays in an in-memory SQLite database.
const db = new Database(":memory:");
db.run("PRAGMA foreign_keys=ON");
for (const sql of sqliteSchema) db.run(sql);
let clock = new Date("2026-10-02T01:00:00Z"); // 09:00 Asia/Shanghai
const now = () => clock;
const id = () => crypto.randomUUID();
const shopId = "gap-repro";
const shop: TenantShop = {
  id: shopId,
  public_id: shopId,
  name: shopId,
  latitude: 0,
  longitude: 0,
  radius_meters: 0,
  billing_enabled: 1,
  cashier_enabled: 0,
  auto_register: 0,
  identity_binding_required: 1,
  checkin_geo: 0,
  checkout_geo: 0,
  machine_geo: 0,
  entry_pricing_ids_json: "[]",
  bot_contact: "",
  time_zone: "Asia/Shanghai",
  hero_url: null,
};
const d1 = createD1DatabaseFromSqlite(db);
const deps = createShopDependencies({ db: d1, shop, now, id });
const repositories = deps.repositories;

await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Shanghai" });
db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES(?, 'player', 'Gap test', 'active', ?)", [shopId, clock.toISOString()]);
db.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable) VALUES(?,'currency','paid','Balance',1)", [shopId]);
db.run("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES(?,'wallet','player','currency','paid',100000)", [shopId]);
const plan: PricingConfig = {
  id: "only-plan", kind: "time.priority", name: "单方案", enabled: true,
  status: "active", createdAt: clock, updatedAt: clock,
  provider: { id: "provider", timeZone: "UTC", rules: [{
    id: "business", label: "营业时段", priority: 1,
    timeRange: { start: "02:00", end: "14:00" },
    pricing: { unitMinutes: 60, unitPrice: 10, roundGraceMinutes: 0, priceCap: 1000 },
  }] },
};
validatePricingConfig(plan);
await repositories.pricingConfigs.save(plan);
for (const localTime of ["09:00", "22:00", "23:00"]) {
  clock = new Date(`2026-10-02T${localTime}:00+08:00`);
  await assert.rejects(deps.playerCommands.startSession({ playerId: "player", pricingConfigIds: [plan.id] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME");
}
clock = new Date("2026-10-02T21:00:00+08:00");
await deps.playerCommands.startSession({ playerId: "player", pricingConfigIds: [plan.id], label: "entry" });
const observations: unknown[] = [];
const displayMismatches: unknown[] = [];
for (const [at, expected] of [["2026-10-02T22:00:00+08:00", 10], ["2026-10-02T23:00:00+08:00", 10], ["2026-10-03T09:00:00+08:00", 10], ["2026-10-03T11:00:00+08:00", 20]] as const) {
  clock = new Date(at);
  const preview = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "player" });
  assert.equal(preview.settlementPreview.total, centsOf(expected));
  const billTimeline = buildBillTimeline({ at: clock, sessions: preview.sessionPreviews, adjustments: preview.adjustments, globalCapWindows: preview.globalCapWindows });
  for (const item of preview.chargeItems) {
    const displayed = billTimeline.events.flatMap(event => event.entries).find(entry => entry.startedAt === item.period?.startedAt.toISOString());
    if (displayed && displayed.endedAt !== item.period?.endedAt.toISOString()) {
      displayMismatches.push({ previewAt: at, actualChargeEnd: item.period?.endedAt, displayedChargeEnd: displayed.endedAt });
    }
  }
  observations.push({ at, total: yuanOf(preview.settlementPreview.total),
    chargePeriods: preview.chargeItems.map(item => ({ start: item.period?.startedAt, end: item.period?.endedAt, amount: yuanOf(item.amount) })),
    timeline: billTimeline });
}
const timeline = buildPriorityTimePricingTimeline({ config: plan.provider, displayTimeZone: "Asia/Shanghai", localDate: "2026-10-02" });
assert.deepEqual(timeline.segments.map(segment => [segment.startLabel, segment.endLabel, !!segment.isClosed]),
  [["00:00", "10:00", true], ["10:00", "22:00", false], ["22:00", "24:00", true]]);
assert.deepEqual(displayMismatches, []);
const checkout = await deps.playerCheckoutCommands!.checkout({ playerId: "player", closeSessionsBeforeBalanceCheck: false });
assert.equal(checkout.playerSettlement.total, centsOf(20));
assert.equal((await repositories.assets.listAssetHoldings("player"))[0]!.quantity, centsOf(980));
console.log(JSON.stringify({ admission: "09:00/22:00/23:00 rejected; 21:00 accepted", dailyTimeline: timeline, observations, displayMismatches, checkoutTotal: yuanOf(checkout.playerSettlement.total) }, null, 2));
db.close();
