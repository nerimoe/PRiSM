import { parseLocalDateTime } from "./pricing-time";
import { PrismDomainError } from "./errors";
type ClockRule = {
  timeRange?: { start: string; end: string };
  weekdays?: readonly number[];
  specificDates?: readonly string[];
};

/** Boundary conversion only: persisted schedules and billing use UTC. */
export function convertPricingRuleClock<T extends ClockRule>(
  rule: T, fromTimeZone: string, toTimeZone: string, referenceDate: string,
): T {
  if (!rule.timeRange || fromTimeZone === toTimeZone) return { ...rule };
  const parts = (at: Date) => {
    const fields = new Intl.DateTimeFormat("en-CA", {
      timeZone: toTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at);
    const field = (name: string) => fields.find(part => part.type === name)!.value;
    return { date: `${field("year")}-${field("month")}-${field("day")}`, clock: `${field("hour")}:${field("minute")}` };
  };
  const anchorDate = rule.specificDates?.[0] ?? referenceDate;
  const start = parts(parseLocalDateTime(anchorDate, rule.timeRange.start, fromTimeZone));
  const endDate = rule.timeRange.start >= rule.timeRange.end ? addDays(anchorDate, 1) : anchorDate;
  const end = rule.timeRange.start === rule.timeRange.end ? start : parts(parseLocalDateTime(endDate, rule.timeRange.end, fromTimeZone));
  for (const date of rule.specificDates ?? []) {
    const datedStart = parts(parseLocalDateTime(date, rule.timeRange.start, fromTimeZone));
    const datedEnd = rule.timeRange.start === rule.timeRange.end ? datedStart : parts(parseLocalDateTime(rule.timeRange.start >= rule.timeRange.end ? addDays(date, 1) : date, rule.timeRange.end, fromTimeZone));
    if (datedStart.clock !== start.clock || datedEnd.clock !== end.clock) {
      throw new PrismDomainError("Dates with different UTC offsets require separate pricing rules.", "PRICING_DATES_REQUIRE_SEPARATE_UTC_RULES");
    }
  }
  const dayShift = Math.round((Date.parse(`${start.date}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / 86_400_000);
  return {
    ...rule,
    timeRange: { start: start.clock, end: end.clock },
    ...(rule.weekdays ? { weekdays: rule.weekdays.map(day => (day + dayShift + 7) % 7) } : {}),
    ...(rule.specificDates ? { specificDates: rule.specificDates.map(date =>
      parts(parseLocalDateTime(date, rule.timeRange!.start, fromTimeZone)).date) } : {}),
  };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
