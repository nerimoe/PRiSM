import { formatOffsetTimestamp, timestampDisplayParts } from "@prism/core";

/** Merchant views pass the shop zone; player views default to the browser's zone. */
export function billTime(at: string, timeZone?: string) {
  return timestampDisplayParts(formatOffsetTimestamp(at, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)) ?? { date: "", time: "—", seconds: "—", offset: "+00:00" };
}
export function displayDateTime(at: string, timeZone?: string): string {
  const parts = billTime(at, timeZone);
  return parts.date ? `${parts.date} ${parts.time}` : "—";
}

export function billPeriod(startedAt: string, endedAt: string, timeZone?: string): string {
  const start = billTime(startedAt, timeZone), end = billTime(endedAt, timeZone);
  const startTime = start.time + (start.offset !== end.offset ? ` UTC${start.offset}` : "");
  const endTime = end.time + (start.offset !== end.offset ? ` UTC${end.offset}` : "");
  if (start.date === end.date) return `${startTime} – ${endTime}`;
  const sameYear = start.date.slice(0, 4) === end.date.slice(0, 4);
  return `${sameYear ? start.date.slice(5) : start.date} ${startTime} – ${sameYear ? end.date.slice(5) : end.date} ${endTime}`;
}

export type DateBucket<T> = {
  localDate: string;
  items: T[];
};

/** Groups timestamped items into consecutive buckets by local shop date. */
export function groupByDate<T>(
  items: readonly T[],
  getTimestamp: (item: T) => string,
  timeZone?: string,
): DateBucket<T>[] {
  const buckets: DateBucket<T>[] = [];
  for (const item of items) {
    const localDate = billTime(getTimestamp(item), timeZone).date;
    const prev = buckets[buckets.length - 1];
    if (prev && prev.localDate === localDate) {
      prev.items.push(item);
      continue;
    }
    buckets.push({ localDate, items: [item] });
  }
  return buckets;
}

/** Formats YYYY-MM-DD as a compact localized month/day, adding the year when cross-year. */
export function shortDateLabel(localDate: string, todayDate?: string): string {
  if (!localDate) return "—";
  const crossYear = todayDate ? localDate.slice(0, 4) !== todayDate.slice(0, 4) : false;
  return new Date(`${localDate}T12:00:00Z`).toLocaleDateString([], {
    timeZone: "UTC",
    ...(crossYear ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
  });
}
