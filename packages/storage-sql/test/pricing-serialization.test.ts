import { expect, test } from "bun:test";
import { serializePricingProviderConfig } from "../src";

test("new pricing clocks default to UTC at persistence without shifting times, weekdays or dates", () => {
  const provider = { id: "rate", rules: [{ id: "day", label: "白天", priority: 1,
    timeRange: { start: "02:00", end: "19:00" }, weekdays: [1], specificDates: ["2026-10-06"],
    pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 } }] };
  const stored = serializePricingProviderConfig(provider);
  expect(stored).toMatchObject({ timeZone: "UTC", rules: [{ timeRange: provider.rules[0]!.timeRange,
    weekdays: [1], specificDates: ["2026-10-06"], pricing: { unitPrice: 1800, priceCap: 9000 } }] });
  expect(provider).not.toHaveProperty("timeZone");
  expect(serializePricingProviderConfig({ id: "cap", includedPricingConfigIds: ["rate"],
    rules: [{ id: "day", label: "全天", priority: 1, timeRange: { start: "00:00", end: "00:00" }, priceCap: 90 }] }))
    .toMatchObject({ timeZone: "UTC", rules: [{ priceCap: 9000 }] });
});

test("legacy source zones survive serialization for conversion; fixed charges need no clock metadata", () => {
  const provider = { id: "rate", timeZone: "Asia/Shanghai", rules: [{ id: "day", label: "白天", priority: 1,
    timeRange: { start: "10:00", end: "03:00" },
    pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 } }] };
  expect(serializePricingProviderConfig(provider)).toMatchObject({ timeZone: "Asia/Shanghai",
    rules: [{ timeRange: { start: "10:00", end: "03:00" } }] });
  expect(serializePricingProviderConfig({ id: "fixed", label: "门票", amount: 18 }))
    .toEqual({ id: "fixed", label: "门票", amount: 1800 });
});
