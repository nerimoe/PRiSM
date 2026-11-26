import { describe, expect, it } from "vitest";
import type { AnnouncementSchedule } from "@prism/core";
import {
  formatScheduleRepeat,
  isScheduleRuleInvalid,
  scheduleMode,
  switchScheduleMode,
  toggleScheduleWeekday,
} from "./bot-schedules";

const identity = (key: string) => key;

const baseRule = (over: Partial<AnnouncementSchedule> = {}): AnnouncementSchedule => ({
  id: "rule-1",
  enabled: true,
  time: "18:00",
  text: "今晚有活动",
  ...over,
});

describe("bot schedule helpers", () => {
  it("detects daily, weekly, and once repeat modes", () => {
    expect(scheduleMode(baseRule())).toBe("daily");
    expect(scheduleMode(baseRule({ weekdays: [1, 5] }))).toBe("weekly");
    expect(scheduleMode(baseRule({ date: "2026-12-01" }))).toBe("once");
    expect(scheduleMode(baseRule({ date: "" }))).toBe("once");
  });

  it("validates text, HH:mm time, YYYY-MM-DD date, and non-empty weekdays", () => {
    expect(isScheduleRuleInvalid(baseRule())).toBe(false);
    expect(isScheduleRuleInvalid(baseRule({ weekdays: [5, 6] }))).toBe(false);
    expect(isScheduleRuleInvalid(baseRule({ date: "2026-12-01" }))).toBe(false);

    expect(isScheduleRuleInvalid(baseRule({ text: "   " }))).toBe(true);
    expect(isScheduleRuleInvalid(baseRule({ time: "" }))).toBe(true);
    expect(isScheduleRuleInvalid(baseRule({ time: "9:00" }))).toBe(true);
    expect(isScheduleRuleInvalid(baseRule({ time: "25:00" }))).toBe(true);
    expect(isScheduleRuleInvalid(baseRule({ date: "" }))).toBe(true);
    expect(isScheduleRuleInvalid(baseRule({ date: "2026/12/01" }))).toBe(true);
    expect(isScheduleRuleInvalid(baseRule({ weekdays: [] }))).toBe(true);
  });

  it("toggles weekdays with deduplication and Mon–Sun ordering", () => {
    expect(toggleScheduleWeekday([5, 5, 0], 1)).toEqual([1, 5, 0]);
    expect(toggleScheduleWeekday([1, 5, 0], 5)).toEqual([1, 0]);
    expect(toggleScheduleWeekday(undefined, 3)).toEqual([3]);
    expect(toggleScheduleWeekday([0], 0)).toEqual([]);
  });

  it("switches between repeat modes while preserving valid values or filling defaults", () => {
    const daily = baseRule();
    expect(switchScheduleMode(daily, "weekly", "2026-11-27")).toEqual({
      date: undefined,
      weekdays: [1],
    });
    expect(switchScheduleMode(baseRule({ weekdays: [5, 5, 6] }), "weekly", "2026-11-27")).toEqual({
      date: undefined,
      weekdays: [5, 6],
    });
    expect(switchScheduleMode(daily, "once", "2026-11-27")).toEqual({
      date: "2026-11-27",
      weekdays: undefined,
    });
    expect(switchScheduleMode(baseRule({ date: "2026-12-25" }), "once", "2026-11-27")).toEqual({
      date: "2026-12-25",
      weekdays: undefined,
    });
    expect(switchScheduleMode(baseRule({ date: "2026-12-25" }), "daily", "2026-11-27")).toEqual({
      date: undefined,
      weekdays: undefined,
    });
  });

  it("formats repeat labels in Mon–Sun order and handles empty selections", () => {
    expect(formatScheduleRepeat(baseRule(), identity)).toBe("每天");
    expect(formatScheduleRepeat(baseRule({ weekdays: [0, 5, 1] }), identity)).toBe("周一、周五、周日");
    expect(formatScheduleRepeat(baseRule({ weekdays: [] }), identity)).toBe("未选星期");
    expect(formatScheduleRepeat(baseRule({ date: "2026-12-01" }), identity)).toBe("2026-12-01");
    expect(formatScheduleRepeat(baseRule({ date: "" }), identity)).toBe("未选日期");
  });
});
