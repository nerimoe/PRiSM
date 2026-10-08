import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { centsOf, yuanOf, convertPricingRuleClock } from "../packages/core/src";
import { sqliteSchema } from "../packages/storage-sql/src";
import { RuntimeRepositories, createPrismRuntimeDependencies } from "../packages/runtime/src";
import { buildBillTimeline } from "../packages/application/src/bill-timeline";
import { billTime, billPeriod } from "../packages/prism-web/src/ui/bill-time";

// Verify the screenshot scenario after the UTC/UI boundary fix, entirely in memory.
const db = new Database(":memory:");
db.run("PRAGMA foreign_keys=ON");
for (const sql of sqliteSchema) db.run(sql);
let clock = new Date("2026-10-02T10:08:00+08:00");
const now = () => clock, id = () => crypto.randomUUID(), shopId = "timezone-repro";
const repositories = RuntimeRepositories.fromBunSqlite({ db, shopId, now, id });
const deps = createPrismRuntimeDependencies({
  repositories, queries: RuntimeRepositories.queriesFromBunSqlite({ db, shopId, now }),
  now, id, pricingProviders: [], assetEffectProviders: [], coinCooldownMs: 0,
});
await repositories.system.setAppSetting("store.profile", { timeZone: "Asia/Shanghai" });
for (const player of ["existing", "new", "after-setting", "closed"]) {
  db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES(?,?,?,'active',?)", [shopId, player, player, clock.toISOString()]);
}
const rule = convertPricingRuleClock({ id: "base", label: "基础计费", priority: 1,
  timeRange: { start: "10:00", end: "03:00" },
  pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 },
}, "Asia/Shanghai", "UTC", "2026-10-02");
const plan = await deps.staffPricingCommands.createPricingConfig({ name: "音游工坊", kind: "time.priority", enabled: true,
  provider: { id: "provider", timeZone: "UTC", rules: [rule] } });
assert.deepEqual(plan.kind === "time.priority" && plan.provider.rules[0]?.timeRange, { start: "02:00", end: "19:00" });
const session = await deps.playerCommands.startSession({ playerId: "existing", pricingConfigIds: [plan.id], label: "entry" });
const release = await repositories.pricingConfigs.findRelease!(session.pricingReleaseId!);
assert.equal(release?.timeZone, "UTC");
clock = new Date("2026-10-02T11:54:00+08:00");
const preview = await deps.playerCheckoutCommands!.previewCheckout({ playerId: "existing" });
assert.equal(preview.settlementPreview.total, centsOf(36));
await deps.playerCommands.startSession({ playerId: "new", pricingConfigIds: [plan.id] });
const timeline = buildBillTimeline({ at: clock, sessions: preview.sessionPreviews, adjustments: preview.adjustments, globalCapWindows: preview.globalCapWindows });
assert.equal(billTime(session.startedAt.toISOString(), "Asia/Shanghai").time, "10:08");
assert.equal(billTime(timeline.events[0]!.at, "Asia/Shanghai").time, "11:54");
const charge = timeline.events[0]!.entries.find(entry => entry.amount !== null)!;
assert.equal(billPeriod(charge.startedAt!, charge.endedAt!, "Asia/Shanghai"), "10:08 – 11:54");
await repositories.system.setAppSetting("store.profile", { timeZone: "America/New_York" });
const after = await deps.playerCommands.startSession({ playerId: "after-setting", pricingConfigIds: [plan.id] });
assert.equal(after.pricingReleaseId, session.pricingReleaseId);
assert.equal((await deps.playerCheckoutCommands!.previewCheckout({ playerId: "existing" })).settlementPreview.total, centsOf(36));
clock = new Date("2026-10-03T03:00:00+08:00");
await assert.rejects(deps.playerCommands.startSession({ playerId: "closed", pricingConfigIds: [plan.id] }),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "PLAYER_SESSION_OUTSIDE_BILLABLE_TIME");
console.log(JSON.stringify({ storedClock: rule.timeRange, businessTimeZone: release?.timeZone,
  shanghaiBill: "10:08 – 11:54", elapsedMinutes: 106, totalYuan: yuanOf(preview.settlementPreview.total),
  admissionAt1154: "accepted", admissionAt0300: "rejected", displayZoneChangeKeepsReleaseAndAmount: true }, null, 2));
db.close();
