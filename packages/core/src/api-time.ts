import { dateTimeFormatterCache } from "./date-time-formatter";

/** Wire instants retain an explicit offset; business Date values remain unchanged. */
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export function isApiInstant(value: unknown): value is string {
  return typeof value === "string" && instantPattern.test(value) && Number.isFinite(Date.parse(value));
}

const offsetFormatter = dateTimeFormatterCache({
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function formatOffsetTimestamp(value: string, timeZone: string): string {
  if (!isApiInstant(value)) return value;
  const date = new Date(value);
  if (timeZone === "UTC") return date.toISOString();
  const parts = offsetFormatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  const local = `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const offsetMinutes = Math.round((Date.parse(`${local}Z`) - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const minutes = Math.abs(offsetMinutes);
  const offset = `${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `${local}.${String(date.getUTCMilliseconds()).padStart(3, "0")}${offsetMinutes === 0 ? "Z" : offset}`;
}

/** Use an offset carried by the API; an IANA fallback supports older Z-only responses. */
export function timestampDisplayParts(value: string, legacyTimeZone?: string) {
  if (!isApiInstant(value)) return null;
  const explicitOffset = value.match(/[+-]\d{2}:\d{2}$/)?.[0];
  const local = explicitOffset ? value : legacyTimeZone ? formatOffsetTimestamp(value, legacyTimeZone) : value;
  return { date: local.slice(0, 10), time: local.slice(11, 16), seconds: local.slice(11, 19), offset: local.match(/[+-]\d{2}:\d{2}$/)?.[0] ?? "+00:00" };
}

export function formatApiDateTime(value: string, legacyTimeZone?: string): string {
  const parts = timestampDisplayParts(value, legacyTimeZone);
  return parts ? `${parts.date} ${parts.time}` : "—";
}
