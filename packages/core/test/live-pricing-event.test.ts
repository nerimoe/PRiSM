import { expect, test } from "bun:test";
import { createPriorityTimePricingProvider, nextTimePricingEvent, type PriorityTimePricingProviderConfig, type Session } from "../src";

const start = new Date("2026-09-23T09:07:12.000Z");
const session: Session = { id: "visit", playerId: "player", startedAt: start, status: "active" };
const plan = (grace: number): PriorityTimePricingProviderConfig => ({ id: "rate", timeZone: "UTC", rules: [
  { id: "day", label: "日场", priority: 1, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 30, unitPrice: 6, roundGraceMinutes: grace, priceCap: 1000 } },
] });

test("next charge matches the existing billing engine across grace, minute rounding and device activity", () => {
  for (const grace of [0, 5, 29]) for (const operated of [false, true]) {
    const config = plan(grace);
    const currentSession = { ...session, metadata: { deviceOperated: operated } };
    const provider = createPriorityTimePricingProvider(config);
    const cache = new Map<number, number>();
    const amount = (minute: number) => {
      if (!cache.has(minute)) cache.set(minute, (provider.quote({ session: currentSession, assetHoldings: [], now: new Date(+start + minute * 60_000) }) as import("../src").ChargeItem[]).reduce((sum, item) => sum + item.amount, 0));
      return cache.get(minute)!;
    };
    for (const minute of [0, 1, 5, 6, 29, 30, 31, 59, 60]) {
      const now = new Date(+start + minute * 60_000);
      const next = nextTimePricingEvent({ config, session: currentSession, now });
      let expected = minute + 1;
      while (amount(expected) === amount(minute) && expected < minute + 61) expected++;
      expect(next.chargeAt?.getTime()).toBe(+start + expected * 60_000);
    }
  }
});

test("higher priority switch wins before charging, while a reached cap hides only charging", () => {
  const config = plan(29);
  config.rules = [...config.rules, { ...config.rules[0]!, id: "night", label: "夜场", priority: 2, timeRange: { start: "09:20", end: "10:00" } }];
  const next = nextTimePricingEvent({ config, session, now: new Date("2026-09-23T09:10:00Z") });
  expect(next.ruleAt?.toISOString()).toBe("2026-09-23T09:20:00.000Z");
  expect(next.chargeAt).toBeNull();
  const capped = nextTimePricingEvent({ config: plan(0), session, now: start, intervalCapReached: true });
  expect(capped.chargeAt).toBeNull();
});

test("switch uses store timezone and an old interval cap does not suppress the new interval", () => {
  const config = plan(0);
  config.timeZone = "Asia/Tokyo";
  config.rules = [{ ...config.rules[0]!, timeRange: { start: "18:00", end: "19:00" } },
    { ...config.rules[0]!, id: "night", label: "夜场", timeRange: { start: "19:00", end: "18:00" } }];
  expect(nextTimePricingEvent({ config, session, now: start }).ruleAt?.toISOString()).toBe("2026-09-23T10:00:00.000Z");
  const switched = nextTimePricingEvent({ config, session, now: new Date("2026-09-23T10:00:00Z"), intervalCapReached: true, intervalStartedAt: start });
  expect(switched.ruleLabel).toBe("夜场");
  expect(switched.chargeAt?.toISOString()).toBe("2026-09-23T10:01:00.000Z");
});
