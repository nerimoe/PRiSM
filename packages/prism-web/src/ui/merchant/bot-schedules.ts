import type { AnnouncementSchedule } from "@prism/core";

/** UI weekday button display order (Monday through Sunday) in JS `Date.getDay()` numbering. */
export const SCHEDULE_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** i18n keys indexed directly by JS `Date.getDay()` (`0 = Sun` .. `6 = Sat`). */
export const SCHEDULE_DAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

export type ScheduleRepeatMode = "daily" | "weekly" | "once";

/** Determines which repeat mode a scheduled announcement uses. */
export function scheduleMode(rule: AnnouncementSchedule): ScheduleRepeatMode {
  if (rule.date !== undefined) return "once";
  if (rule.weekdays !== undefined) return "weekly";
  return "daily";
}

/** Returns true when a schedule rule lacks valid text, time, date, or weekdays. */
export function isScheduleRuleInvalid(rule: AnnouncementSchedule): boolean {
  return (
    !rule.text.trim() ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time) ||
    (rule.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(rule.date)) ||
    (rule.weekdays !== undefined && rule.weekdays.length === 0)
  );
}

/** Toggles one JS weekday number and returns deduplicated days in Mon–Sun order. */
export function toggleScheduleWeekday(current: readonly number[] | undefined, day: number): number[] {
  const next = new Set(current ?? []);
  if (next.has(day)) next.delete(day);
  else next.add(day);
  return SCHEDULE_WEEKDAY_ORDER.filter((one) => next.has(one));
}

/** Builds the field patch when switching a schedule rule between repeat modes. */
export function switchScheduleMode(
  rule: AnnouncementSchedule,
  mode: ScheduleRepeatMode,
  defaultDate: string,
): Partial<AnnouncementSchedule> {
  if (mode === "daily") return { date: undefined, weekdays: undefined };
  if (mode === "weekly") {
    return {
      date: undefined,
      weekdays: rule.weekdays?.length ? [...new Set(rule.weekdays)] : [1],
    };
  }
  return {
    date: rule.date && /^\d{4}-\d{2}-\d{2}$/.test(rule.date) ? rule.date : defaultDate,
    weekdays: undefined,
  };
}

/** Formats the repeat cadence of a schedule rule for compact list and preview badges. */
export function formatScheduleRepeat(rule: AnnouncementSchedule, t: (key: string) => string): string {
  const mode = scheduleMode(rule);
  if (mode === "once") return rule.date || t("未选日期");
  if (mode === "weekly") {
    return rule.weekdays?.length
      ? SCHEDULE_WEEKDAY_ORDER.filter((day) => rule.weekdays!.includes(day))
          .map((day) => t(SCHEDULE_DAY_LABELS[day]!))
          .join("、")
      : t("未选星期");
  }
  return t("每天");
}
