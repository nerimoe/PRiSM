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
