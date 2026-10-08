import { expect, test } from "bun:test";
import { createPriorityTimePricingProvider, explainTimeCapPricing, nextTimePricingEvent, previousBillingEvent,
  type ChargeItem, type PriorityTimePricingProviderConfig, type Session, type TimeCapPricingProviderConfig } from "../src";

const start = new Date("2026-09-23T09:07:12Z");
const at = (minutes: number) => new Date(+start + minutes * 60_000);
const session: Session = { id: "visit", playerId: "player", startedAt: start, status: "active" };
const plan = (grace: number, cap = 1000): PriorityTimePricingProviderConfig => ({ id: "rate", pricingConfigId: "rate", timeZone: "UTC", rules: [
  { id: "day", label: "日场", priority: 1, dateTimeRange: { start, end: at(180) },
    pricing: { unitMinutes: 30, unitPrice: 6, roundGraceMinutes: grace, priceCap: cap } },
] });
function resolve(config: PriorityTimePricingProviderConfig, sessions: Session[], minute: number, cap?: TimeCapPricingProviderConfig) {
  const now = at(minute);
  const provider = createPriorityTimePricingProvider(config);
  const chargeItems = sessions.flatMap(session => provider.quote({ session, assetHoldings: [], now }) as ChargeItem[]);
  return previousBillingEvent({ now, sessions, chargeItems,
    globalCapWindows: cap ? explainTimeCapPricing({ config: cap, chargeItems }) : [],
    ruleBoundaries: sessions.flatMap(session => [nextTimePricingEvent({ config, session, now }).intervalStartedAt,
      ...(cap ? [nextTimePricingEvent({ config: cap, session, now }).intervalStartedAt] : [])]) });
}

test("previous charge matches actual quote changes and stays stable between refreshes", () => {
  for (const grace of [0, 5, 29]) for (const operated of [false, true]) {
    const config = plan(grace);
    const current = { ...session, metadata: { deviceOperated: operated } };
    const provider = createPriorityTimePricingProvider(config);
    let previous = 0, lastChange = 0;
    for (let minute = 0; minute <= 65; minute++) {
      const quote = provider.quote({ session: current, assetHoldings: [], now: at(minute) }) as ChargeItem[];
      const amount = quote.reduce((sum, item) => sum + item.amount, 0);
      if (amount !== previous) lastChange = minute;
      previous = amount;
      expect(resolve(config, [current], minute)?.at).toEqual(at(lastChange));
      expect(resolve(config, [current], minute + 0.5)?.at).toEqual(at(lastChange));
    }
  }
});

test("an individual cap preserves the actual cap charge instead of later unit ticks", () => {
  expect(resolve(plan(5, 10), [session], 95)).toEqual({ at: at(35), label: "计费" });
});

test("staggered visits share a cap and suppress every later raw pricing tick", () => {
  const cap: TimeCapPricingProviderConfig = { id: "cap", includedPricingConfigIds: ["rate"], rules: [
    { id: "cap-day", label: "全局封顶", priority: 1, dateTimeRange: { start, end: at(180) }, priceCap: 10 },
  ] };
  const visits = [session, { ...session, id: "extra", startedAt: at(15) }];
  expect(resolve(plan(5), visits, 65, cap)).toEqual({ at: at(20), label: "计费" });
  expect(resolve(plan(5), visits, 65.5, cap)).toEqual({ at: at(20), label: "计费" });
});

test("paid cap history is included when recovering the last bill change", () => {
  const config = plan(5);
  const cap: TimeCapPricingProviderConfig = { id: "cap", includedPricingConfigIds: ["rate"],
    paidHistory: { [`cap@cap-day@${start.toISOString()}`]: 600 as import("../src").Cents }, rules: [
      { id: "cap-day", label: "全局封顶", priority: 1, dateTimeRange: { start, end: at(180) }, priceCap: 10 },
    ] };
  expect(resolve(config, [session], 65, cap)).toEqual({ at: at(5), label: "计费" });
});

test("a paused rule interval and an exact switch remain visible without any charge", () => {
  const config = plan(5);
  config.rules = [{ ...config.rules[0]!, dateTimeRange: { start, end: at(40) } },
    { ...config.rules[0]!, id: "night", dateTimeRange: { start: at(80), end: at(180) } }];
  expect(resolve(config, [session], 60)).toEqual({ at: at(40), label: "规则切换" });
  expect(resolve(config, [session], 80)).toEqual({ at: at(80), label: "规则切换" });
  expect(resolve(config, [session], 85)).toEqual({ at: at(85), label: "计费" });
});

test("entry is the first event, and a real session end is retained", () => {
  expect(resolve(plan(29), [session], 10)).toEqual({ at: start, label: "入场" });
  const now = at(50);
  expect(previousBillingEvent({ now, sessions: [{ ...session, endedAt: at(45), status: "closed" }],
    chargeItems: [], globalCapWindows: [], ruleBoundaries: [] })).toEqual({ at: at(45), label: "结束计费" });
  expect(previousBillingEvent({ now, sessions: [], chargeItems: [], globalCapWindows: [], ruleBoundaries: [] })).toBeNull();
});


test("a cap starting inside a charge period recovers its prorated reach time", () => {
  const cap: TimeCapPricingProviderConfig = { id: "cap", includedPricingConfigIds: ["rate"], rules: [
    { id: "cap-day", label: "全局封顶", priority: 1, dateTimeRange: { start: at(10), end: at(180) }, priceCap: 3 },
  ] };
  // The cap engine rounds the prorated amount to cents: 2.995 yuan
  // already rounds to the 3-yuan cap, slightly before the whole minute.
  const reachedAt = new Date(+start + Math.ceil(600_000 / (1 - 299.5 / 600)));
  expect(resolve(plan(5), [session], 65, cap)).toEqual({ at: reachedAt, label: "计费" });
});


test("a later looser overlapping cap cannot reset an already capped timeline", () => {
  const config = plan(5);
  const now = at(65);
  const chargeItems = createPriorityTimePricingProvider(config).quote({ session, assetHoldings: [], now }) as ChargeItem[];
  const globalCapWindows = [6, 12].flatMap(priceCap => explainTimeCapPricing({ chargeItems, config: {
    id: `cap-${priceCap}`, includedPricingConfigIds: ["rate"], rules: [
      { id: "cap-day", label: "封顶", priority: 1, dateTimeRange: { start, end: at(180) }, priceCap },
    ],
  } }));
  expect(previousBillingEvent({ now, sessions: [session], chargeItems, globalCapWindows, ruleBoundaries: [start] }))
    .toEqual({ at: at(5), label: "计费" });
});

test("device grace invalidation is consumed by the first positive segment", () => {
  const config = plan(29);
  config.rules = [{ ...config.rules[0]!, dateTimeRange: { start, end: at(40) } },
    { ...config.rules[0]!, id: "night", dateTimeRange: { start: at(40), end: at(180) } }];
  const operated = { ...session, metadata: { deviceOperated: true } };
  expect(resolve(config, [operated], 50)).toEqual({ at: at(40), label: "规则切换" });
  expect(resolve(config, [operated], 69)).toEqual({ at: at(69), label: "计费" });
});


test("an uncapped stacked plan keeps producing events after another plan caps", () => {
  const now = at(75);
  const first = plan(5, 6);
  const second = plan(10);
  second.id = "extra-rate";
  second.pricingConfigId = "extra-rate";
  second.rules = [{ ...second.rules[0]!, pricing: { ...second.rules[0]!.pricing, unitMinutes: 60, unitPrice: 10 } }];
  const chargeItems = [first, second].flatMap(config =>
    createPriorityTimePricingProvider(config).quote({ session, assetHoldings: [], now }) as ChargeItem[]);
  expect(previousBillingEvent({ now, sessions: [session], chargeItems, globalCapWindows: [], ruleBoundaries: [start] }))
    .toEqual({ at: at(70), label: "计费" });
});
