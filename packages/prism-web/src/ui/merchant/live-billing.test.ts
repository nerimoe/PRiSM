import { expect, test } from "bun:test";
import { liveBilling } from "./live-billing";
import type { LivePlayer } from "./shared";

test("billing groups retain overnight ranges and concurrent plans without duplicating periods", () => {
  const session: LivePlayer["sessions"][number] = {
    id: "s", startedAt: "2026-09-11T14:00:00Z", endedAt: null,
    pricingCharges: [{ pricingConfigId: "night", planName: "夜场", ruleLabel: "夜间" }],
    pricingSegments: [{ pricingConfigId: "night", ruleId: "r", planName: "夜场", ruleLabel: "夜间", ruleTimeRange: { start: "22:00", end: "06:00" } }],
  };
  const fixed = { ...session, id: "fixed", pricingSegments: [], pricingCharges: [{ pricingConfigId: "table", planName: "麻将", ruleLabel: "固定费用" }] };
  const bill = liveBilling({ sessions: [session, session, fixed] });
  expect(bill.periods).toEqual(["夜场 · 夜间 22:00–06:00", "麻将 · 固定费用"]);
  expect(bill.planKey).toBe(liveBilling({ sessions: [fixed, session] }).planKey);
  expect(bill.periodKey).toBe(liveBilling({ sessions: [fixed, session] }).periodKey);
  expect(liveBilling({ sessions: [] }).periods).toEqual([]);
});
