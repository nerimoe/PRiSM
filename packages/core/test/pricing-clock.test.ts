import { expect, test } from "bun:test";
import { centsOf, createPriorityTimePricingProvider, type Session, buildPriorityTimePricingTimeline, canStartPriorityTimePricingSession, convertPricingRuleClock } from "../src";

const pricing = { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 };
test("Shanghai editor overnight hours round-trip through UTC and match admission", () => {
  const local = { id: "base", label: "Base", priority: 1, timeRange: { start: "10:00", end: "03:00" }, pricing };
  const utc = convertPricingRuleClock(local, "Asia/Shanghai", "UTC", "2026-10-02");
  expect(utc.timeRange).toEqual({ start: "02:00", end: "19:00" });
  expect(convertPricingRuleClock(utc, "UTC", "Asia/Shanghai", "2026-10-02")).toEqual(local);
  const config = { id: "plan", timeZone: "UTC", rules: [utc] };
  expect(canStartPriorityTimePricingSession({ config, at: new Date("2026-10-02T11:54:00+08:00") })).toBe(true);
  expect(canStartPriorityTimePricingSession({ config, at: new Date("2026-10-03T03:00:00+08:00") })).toBe(false);
  expect(buildPriorityTimePricingTimeline({ config, localDate: "2026-10-02", displayTimeZone: "Asia/Shanghai" }).segments)
    .toMatchObject([
      { startLabel: "00:00", endLabel: "03:00", ruleId: "base" },
      { startLabel: "03:00", endLabel: "10:00", isClosed: true },
      { startLabel: "10:00", endLabel: "24:00", ruleId: "base" },
    ]);
});

test("weekday and dated rule anchors follow the UTC start date across midnight", () => {
  const local = { id: "monday", label: "Monday", priority: 1, timeRange: { start: "00:00", end: "00:00" }, weekdays: [1], specificDates: ["2026-10-05"], pricing };
  const utc = convertPricingRuleClock(local, "Asia/Shanghai", "UTC", "2026-10-05");
  expect(utc.timeRange).toEqual({ start: "16:00", end: "16:00" });
  expect(utc.weekdays).toEqual([0]);
  expect(utc.specificDates).toEqual(["2026-10-04"]);
  const config = { id: "plan", timeZone: "UTC", rules: [utc] };
  expect(canStartPriorityTimePricingSession({ config, at: new Date("2026-10-05T23:59:00+08:00") })).toBe(true);
  expect(canStartPriorityTimePricingSession({ config, at: new Date("2026-10-06T00:00:00+08:00") })).toBe(false);
  expect(convertPricingRuleClock(utc, "UTC", "Asia/Shanghai", "2026-10-04")).toEqual(local);
});

test("UTC schedules display seasonal offsets and absolute date windows stay unchanged", () => {
  const utc = { timeRange: { start: "10:00", end: "12:00" } };
  expect(convertPricingRuleClock(utc, "UTC", "America/New_York", "2026-01-02").timeRange).toEqual({ start: "05:00", end: "07:00" });
  expect(convertPricingRuleClock(utc, "UTC", "America/New_York", "2026-07-02").timeRange).toEqual({ start: "06:00", end: "08:00" });
  const dated = { dateTimeRange: { start: new Date("2026-10-02T00:00:00Z"), end: new Date("2026-10-02T12:00:00Z") } };
  expect(convertPricingRuleClock({ ...dated, timeRange: undefined }, "UTC", "Asia/Shanghai", "2026-10-02")).toEqual({ ...dated, timeRange: undefined });
});


test("full-day UTC cap anchors retain UI midnight without resetting at UTC midnight", async () => {
  const rule = convertPricingRuleClock({ id: "day", label: "Day", priority: 1, timeRange: { start: "00:00", end: "00:00" }, pricing: { ...pricing, priceCap: 18 } }, "Asia/Shanghai", "UTC", "2026-10-05");
  const provider = createPriorityTimePricingProvider({ id: "plan", timeZone: "UTC", rules: [rule] });
  const quote = async (start: string, end: string) => {
    const session: Session = { id: "s", playerId: "p", status: "active", startedAt: new Date(start) };
    const items = await provider.quote({ session, now: new Date(end), assetHoldings: [] });
    return items.reduce((sum, item) => sum + item.amount, 0);
  };
  expect(await quote("2026-10-04T23:00:00+08:00", "2026-10-05T02:00:00+08:00")).toBe(centsOf(36));
  expect(await quote("2026-10-05T07:00:00+08:00", "2026-10-05T10:00:00+08:00")).toBe(centsOf(18));
});

test("fractional offsets shift weekday and date anchors and incompatible dated offsets are rejected", () => {
  const local = { timeRange: { start: "00:15", end: "01:00" }, weekdays: [1], specificDates: ["2026-10-05"] };
  const utc = convertPricingRuleClock(local, "Asia/Kathmandu", "UTC", "2026-10-05");
  expect(utc).toEqual({ timeRange: { start: "18:30", end: "19:15" }, weekdays: [0], specificDates: ["2026-10-04"] });
  expect(convertPricingRuleClock(utc, "UTC", "Asia/Kathmandu", "2026-10-04")).toEqual(local);
  expect(() => convertPricingRuleClock({ timeRange: { start: "01:00", end: "04:00" }, specificDates: ["2026-03-07", "2026-03-08"] }, "America/New_York", "UTC", "2026-03-07")).toThrow("different UTC offsets");
});
