import { expect, test } from "bun:test";
import { centsOf, collectTimeCapPricingHistoryLookupKeys, createPriorityTimePricingProvider, migrateCurrentPricingRules, migrateHistoricalPricingRules, type PriorityTimePricingRule, type Session } from "../src";
const rule: PriorityTimePricingRule = { id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 0, priceCap: 10000 } };

test("current dated DST rules retain 23-hour and 25-hour windows using absolute UTC intervals", async () => {
  const dated = { ...rule, specificDates: ["2026-03-08", "2026-11-01"], weekdays: [0] };
  const rules = migrateCurrentPricingRules([dated], "America/New_York", new Date("2026-10-02")) as PriorityTimePricingRule[];
  expect(rules.map(r => r.dateTimeRange)).toEqual([
    { start: new Date("2026-03-08T05:00:00Z"), end: new Date("2026-03-09T04:00:00Z") },
    { start: new Date("2026-11-01T04:00:00Z"), end: new Date("2026-11-02T05:00:00Z") },
  ]);
  const provider = createPriorityTimePricingProvider({ id: "p", timeZone: "UTC", rules });
  for (const [index, hours] of [[0, 23], [1, 25]] as const) {
    const window = rules[index]!.dateTimeRange!, session: Session = { id: "s", playerId: "p", startedAt: window.start, endedAt: window.end };
    const items = await provider.quote({ session, now: window.end, assetHoldings: [] });
    expect(items.reduce((sum, item) => sum + item.amount, 0)).toBe(centsOf(hours * 18));
  }
});

test("historical UTC materialization retains original anchors for clipped and overnight rules", () => {
  const rules = migrateHistoricalPricingRules([{ ...rule, timeRange: { start: "22:00", end: "03:00" }, specificDates: ["2026-10-02"], dateTimeRange: { start: new Date("2026-10-03T03:00:00Z"), end: new Date("2026-10-03T06:00:00Z") } }], "America/New_York", new Date("2026-10-02"), new Date("2026-10-03"));
  expect(rules).toHaveLength(1);
  expect(rules[0]!.dateTimeRange).toEqual({ start: new Date("2026-10-03T03:00:00Z"), end: new Date("2026-10-03T06:00:00Z") });
  expect(rules[0]!.anchorAt).toEqual(new Date("2026-10-03T02:00:00Z"));
  expect(rules[0]!.timeRange).toBeUndefined();
});


test("split UTC date groups preserve paid cap identities and avoid existing rule IDs", () => {
  const source = { ...rule, specificDates: ["2026-01-02", "2026-07-02"] };
  const rules = migrateCurrentPricingRules([source, { ...rule, id: "day.utc.1", specificDates: ["2026-12-02"] }], "America/New_York", new Date("2026-10-02"));
  expect(new Set(rules.map(rule => rule.id)).size).toBe(rules.length);
  const summer = rules.find(rule => rule.historyRuleId === "day")!;
  const start = new Date("2026-07-02T04:00:00Z"), end = new Date("2026-07-02T05:00:00Z");
  const keys = collectTimeCapPricingHistoryLookupKeys({ config: { id: "cap", timeZone: "UTC", includedPricingConfigIds: ["rate"], rules: [{ ...summer, priceCap: 90 }] },
    chargeItems: [{ id: "i", sessionId: "s", source: "p", label: "Day", amount: centsOf(18), period: { startedAt: start, endedAt: end }, pricingHistory: { pricingConfigId: "rate", providerId: "p", ruleId: "day", ruleAnchorAt: start, amount: centsOf(18) } }] });
  expect(keys[0]!.capRuleId).toBe("day");
  expect(keys[0]!.capAnchorAt).toEqual(start);
});
