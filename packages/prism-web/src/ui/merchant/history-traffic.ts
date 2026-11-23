import type { StaffReportsAnalyticsSource } from "@prism/application";
import {
  addLocalDays,
  clipSessionEffectiveInterval,
  normalizeStayCapHours,
  computeMedian,
  formatLocalDate,
  mergeIntervals,
  parseReportTimestampMs,
} from "@prism/core";

export type HourlyTrafficBucket = {
  hour: number;
  total: number;
  avg: number;
  median: number;
  max: number;
  activeDays: number;
};

export type HistoryTrafficSeries = {
  days: number;
  buckets: HourlyTrafficBucket[];
  totals: number[];
  averages: number[];
  medians: number[];
};

export type HistoryTrafficResult = {
  entries: HistoryTrafficSeries;
  presence: HistoryTrafficSeries;
  clippedSessionCount: number;
};

const round1 = (value: number) => Math.round(value * 10) / 10;

function buildSeries(perHourDaySets: Set<string>[][], days: number): HistoryTrafficSeries {
  const buckets = perHourDaySets.map((daySets, hour): HourlyTrafficBucket => {
    const counts = daySets.map((set) => set.size);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const avg = days > 0 ? round1(total / days) : 0;
    const median = days > 0 ? round1(computeMedian(counts)) : 0;
    const max = counts.length > 0 ? Math.max(...counts) : 0;
    const activeDays = counts.filter((count) => count > 0).length;
    return { hour, total, avg, median, max, activeDays };
  });
  return {
    days,
    buckets,
    totals: buckets.map((bucket) => bucket.total),
    averages: buckets.map((bucket) => bucket.avg),
    medians: buckets.map((bucket) => bucket.median),
  };
}

/**
 * Distinct players per local hour and observed local day, using effective presence
 * intervals (clipped 1 hour after each session's last player activity event) so
 * zombie sessions never inflate overnight hours.
 */
export function historyTraffic(source: StaffReportsAnalyticsSource): HistoryTrafficResult {
  const timeZone = source.range.timeZone;
  const asOfMs = parseReportTimestampMs(source.asOf) ?? Date.now();
  const observedEnd = formatLocalDate(new Date(asOfMs), timeZone);
  const startDate = source.range.startDate;
  const endDate = source.range.endDate < observedEnd ? source.range.endDate : observedEnd;
  const observedDates: string[] = [];
  if (startDate <= endDate) {
    for (let date = startDate; date <= endDate; date = addLocalDays(date, 1)) {
      observedDates.push(date);
    }
  }
  const dateIndex = new Map(observedDates.map((date, index) => [date, index]));
  const observedDays = observedDates.length;

  const entrySets = Array.from({ length: 24 }, () =>
    Array.from({ length: observedDays }, () => new Set<string>()),
  );
  const presenceSets = Array.from({ length: 24 }, () =>
    Array.from({ length: observedDays }, () => new Set<string>()),
  );

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = (stamp: number) => {
    const values = Object.fromEntries(formatter.formatToParts(stamp).map((p) => [p.type, p.value]));
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      hour: Number(values.hour),
      minute: Number(values.minute),
    };
  };

  const from = Date.parse(source.range.from);
  const to = Math.min(Date.parse(source.range.to), asOfMs);
  const byPlayer = new Map<string, [number, number][]>();
  let clippedSessionCount = 0;

  for (const row of source.sessionRows) {
    const start = parseReportTimestampMs(row.started_at);
    const rawEnd = row.ended_at ? parseReportTimestampMs(row.ended_at) : to;
    if (start === null || rawEnd === null) continue;

    if (start >= from && start < to) {
      const local = parts(start);
      const dayIdx = dateIndex.get(local.date);
      if (dayIdx !== undefined) {
        entrySets[local.hour]![dayIdx]!.add(row.player_id);
      }
    }

    const clipped = clipSessionEffectiveInterval({
      startedAtMs: start,
      endedAtMs: rawEnd,
      capMs: normalizeStayCapHours(source.stayCapHours) * 3_600_000,
    });
    if (clipped.inactiveMs > 0 && clipped.effectiveEndMs < to && rawEnd > from) {
      clippedSessionCount += 1;
    }

    const a = Math.max(clipped.startMs, from);
    const b = Math.min(clipped.effectiveEndMs, to);
    if (a >= b) continue;
    const intervals = byPlayer.get(row.player_id) ?? [];
    intervals.push([a, b]);
    byPlayer.set(row.player_id, intervals);
  }

  for (const [player, intervals] of byPlayer) {
    for (const [a, b] of mergeIntervals(intervals)) {
      for (let stamp = a; stamp < b; ) {
        const local = parts(stamp);
        const dayIdx = dateIndex.get(local.date);
        if (dayIdx !== undefined) {
          presenceSets[local.hour]![dayIdx]!.add(player);
        }
        stamp = Math.floor(stamp / 60_000) * 60_000 + (60 - local.minute) * 60_000;
      }
    }
  }

  return {
    entries: buildSeries(entrySets, observedDays),
    presence: buildSeries(presenceSets, observedDays),
    clippedSessionCount,
  };
}
