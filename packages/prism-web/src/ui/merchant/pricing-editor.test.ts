import { describe, expect, it } from "vitest";
import { pricingInZone, toggleWeekday, WEEKDAY_ORDER, weekdayKey } from "./pricing-clock";
import { formatNumericValue, isValidNumericDraft, parseNumericDraft } from "./number-input";
import type { Pricing } from "./Pricing";

describe("pricing editor weekday helpers", () => {
  it("labels Mon–Sun in order matching JS Date.getDay() (0 = Sun)", () => {
    expect(WEEKDAY_ORDER.map(weekdayKey)).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    expect(weekdayKey(0)).toBe("日");
    expect(weekdayKey(1)).toBe("一");
    expect(weekdayKey(5)).toBe("五");
    expect(weekdayKey(6)).toBe("六");
    expect(weekdayKey(7)).toBe("日");
  });

  it("round-trips Shanghai weekday rules through UTC without shifting weekdays", () => {
    const shanghaiPlan: Pricing = {
      id: "plan-1",
      kind: "time.priority",
      name: "Weekday plan",
      enabled: true,
      status: "active",
      provider: {
        id: "provider-1",
        timeZone: "Asia/Shanghai",
        rules: [
          {
            id: "day",
            label: "Day",
            priority: 1,
            weekdays: [1, 2, 3, 4, 5],
            timeRange: { start: "08:00", end: "12:00" },
          },
          {
            id: "night",
            label: "Night",
            priority: 2,
            weekdays: [1, 2, 3, 4, 5],
            timeRange: { start: "00:00", end: "08:00" },
          },
        ],
      },
    };
    const utcPlan = pricingInZone(shanghaiPlan, "Asia/Shanghai", "UTC", "2026-11-23");
    const restored = pricingInZone(utcPlan, "UTC", "Asia/Shanghai", "2026-11-23");
    expect(restored.provider.rules?.[0]?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(restored.provider.rules?.[0]?.weekdays?.map(weekdayKey)).toEqual(["一", "二", "三", "四", "五"]);
    // 00:00–08:00 Asia/Shanghai maps to 16:00–00:00 previous UTC day, and restores back to Mon–Fri.
    expect(utcPlan.provider.rules?.[1]?.weekdays).toEqual([0, 1, 2, 3, 4]);
    expect(restored.provider.rules?.[1]?.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(restored.provider.rules?.[1]?.weekdays?.map(weekdayKey)).toEqual(["一", "二", "三", "四", "五"]);
  });

  it("toggles weekdays from default all-days and deduplicates re-checks", () => {
    expect(toggleWeekday(undefined, 0, false)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(toggleWeekday([1, 2, 3, 4, 5], 5, true)).toEqual([1, 2, 3, 4, 5]);
    expect(toggleWeekday([1, 2, 3, 4, 5], 6, true)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(toggleWeekday([1, 2, 3, 4, 5], 3, false)).toEqual([1, 2, 4, 5]);
  });
});

describe("numeric draft helpers", () => {
  it("allows clearing the field to empty while treating empty as 0", () => {
    expect(isValidNumericDraft("")).toBe(true);
    expect(parseNumericDraft("")).toBe(0);
    expect(isValidNumericDraft("", { integer: true })).toBe(true);
    expect(parseNumericDraft("", { integer: true })).toBe(0);
  });

  it("handles in-progress decimals and negative numbers", () => {
    expect(isValidNumericDraft("10.")).toBe(true);
    expect(parseNumericDraft("10.")).toBe(10);
    expect(isValidNumericDraft(".")).toBe(true);
    expect(parseNumericDraft(".")).toBeNull();
    expect(isValidNumericDraft(".5")).toBe(true);
    expect(parseNumericDraft(".5")).toBe(0.5);
    expect(isValidNumericDraft("10.05")).toBe(true);
    expect(parseNumericDraft("10.05")).toBe(10.05);

    expect(isValidNumericDraft("-", { allowNegative: true })).toBe(true);
    expect(parseNumericDraft("-", { allowNegative: true })).toBeNull();
    expect(isValidNumericDraft("-.", { allowNegative: true })).toBe(true);
    expect(parseNumericDraft("-.", { allowNegative: true })).toBeNull();
    expect(isValidNumericDraft("-0.5", { allowNegative: true })).toBe(true);
    expect(parseNumericDraft("-0.5", { allowNegative: true })).toBe(-0.5);
    expect(parseNumericDraft("-0", { allowNegative: true })).toBe(0);
    expect(Object.is(parseNumericDraft("-0", { allowNegative: true }), 0)).toBe(true);
    expect(parseNumericDraft("-5", { integer: true, allowNegative: true })).toBe(-5);
  });

  it("rejects non-numeric text, disallowed signs, and decimals in integer mode", () => {
    expect(isValidNumericDraft("abc")).toBe(false);
    expect(parseNumericDraft("abc")).toBeNull();
    expect(isValidNumericDraft("-5", { allowNegative: false })).toBe(false);
    expect(isValidNumericDraft("1.5", { integer: true })).toBe(false);
    expect(isValidNumericDraft("1.5.", { allowNegative: true })).toBe(false);
    expect(formatNumericValue(-0)).toBe("0");
    expect(formatNumericValue(Number.NaN)).toBe("");
    expect(formatNumericValue(12.5)).toBe("12.5");
  });
});
