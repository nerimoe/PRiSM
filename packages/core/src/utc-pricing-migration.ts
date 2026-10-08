import { addLocalDays, formatLocalDate, parseLocalDateTime, type PriorityTimePricingRule, type TimeCapPricingRule } from "./pricing-time";
import { convertPricingRuleClock } from "./pricing-clock";

type Rule = PriorityTimePricingRule | TimeCapPricingRule;

/** Preserve historical calendar instances as absolute UTC intervals, including DST. */
export function migrateHistoricalPricingRules(rules: readonly Rule[], sourceZone: string, from: Date, at: Date): Rule[] {
  if (sourceZone === "UTC") return rules.map(rule => ({ ...rule }));
  // These IANA zones have no offset transitions since 2000. Keep common venue
  // histories compact; older dates and seasonal zones use explicit UTC instances.
  const fixedModernZones = ["Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Seoul", "Asia/Singapore", "Asia/Kathmandu", "Asia/Kolkata", "Etc/UTC"];
  if (from.getUTCFullYear() >= 2000 && fixedModernZones.includes(sourceZone) && rules.every(rule => !rule.specificDates?.some(date => date < "2000-01-01"))) {
    return migrateCurrentPricingRules(rules, sourceZone, at);
  }
  return rules.flatMap(rule => {
    if (!rule.timeRange) return [{ ...rule }];
    const firstDate = addLocalDays(formatLocalDate(from, sourceZone), -1);
    const referenceDate = formatLocalDate(at, sourceZone);
    let futureDate = referenceDate;
    let futureAt = parseLocalDateTime(futureDate, rule.timeRange!.start, sourceZone);
    if (futureAt < at) {
      futureDate = addLocalDays(futureDate, 1);
      futureAt = parseLocalDateTime(futureDate, rule.timeRange!.start, sourceZone);
    }
    const dates = rule.specificDates ? [...rule.specificDates] : [];
    if (!rule.specificDates) {
      for (let day = firstDate; day < futureDate; day = addLocalDays(day, 1)) dates.push(day);
    }
    const instances: Rule[] = [];
    for (const date of dates) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (rule.weekdays && !rule.weekdays.includes(weekday)) continue;
      const anchorAt = parseLocalDateTime(date, rule.timeRange.start, sourceZone);
      const endDate = rule.timeRange.start >= rule.timeRange.end ? addLocalDays(date, 1) : date;
      let start = anchorAt, end = parseLocalDateTime(endDate, rule.timeRange.end, sourceZone);
      if (rule.dateTimeRange) {
        start = new Date(Math.max(start.getTime(), rule.dateTimeRange.start.getTime()));
        end = new Date(Math.min(end.getTime(), rule.dateTimeRange.end.getTime()));
      }
      if (end <= start) continue;
      const { timeRange, weekdays, specificDates, dateTimeRange, ...rest } = rule;
      instances.push({ ...rest, anchorAt, dateTimeRange: { start, end } });
    }
    if (!rule.specificDates && (!rule.dateTimeRange || rule.dateTimeRange.end > futureAt)) {
      const normalized = convertPricingRuleClock(rule, sourceZone, "UTC", futureDate);
      instances.push({ ...normalized, dateTimeRange: {
        start: new Date(Math.max(futureAt.getTime(), rule.dateTimeRange?.start.getTime() ?? 0)),
        end: rule.dateTimeRange?.end ?? new Date("9999-12-31T23:59:59Z"),
      } });
    }
    return instances;
  });
}

/** Current editable rules stay compact; finite dated rules split only when offsets differ. */
export function migrateCurrentPricingRules(rules: readonly Rule[], sourceZone: string, at: Date): Rule[] {
  const usedIds = new Set(rules.map(rule => rule.id));
  return rules.flatMap(rule => {
    if (!rule.specificDates?.length || !rule.timeRange) {
      return [convertPricingRuleClock(rule, sourceZone, "UTC", formatLocalDate(at, sourceZone))];
    }
    const groups = new Map<string, Rule>();
    for (const date of rule.specificDates) {
      const converted = convertPricingRuleClock({ ...rule, specificDates: [date] }, sourceZone, "UTC", date);
      const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
      const encodedMinutes = (clockMinutes(converted.timeRange!.end) - clockMinutes(converted.timeRange!.start) + 1440) % 1440 || 1440;
      const actualStart = parseLocalDateTime(date, rule.timeRange!.start, sourceZone);
      const actualEnd = parseLocalDateTime(rule.timeRange!.start >= rule.timeRange!.end ? addLocalDays(date, 1) : date, rule.timeRange!.end, sourceZone);
      if ((actualEnd.getTime() - actualStart.getTime()) / 60_000 !== encodedMinutes) {
        const absolute = migrateHistoricalPricingRules([{ ...rule, specificDates: [date] }], sourceZone, at, at)[0];
        if (absolute) groups.set(`absolute:${date}`, absolute);
        continue;
      }
      const key = JSON.stringify([converted.timeRange, converted.weekdays]);
      const previous = groups.get(key);
      if (previous) previous.specificDates = [...previous.specificDates!, ...converted.specificDates!];
      else groups.set(key, converted);
    }
    return [...groups.values()].map((group, index) => {
      if (!index) return group;
      let suffix = index, id = `${rule.id}.utc.${suffix}`;
      while (usedIds.has(id)) id = `${rule.id}.utc.${++suffix}`;
      usedIds.add(id);
      return { ...group, id, historyRuleId: rule.historyRuleId ?? rule.id };
    });
  });
}
