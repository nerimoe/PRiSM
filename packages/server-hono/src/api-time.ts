import { formatOffsetTimestamp, isApiInstant, timestampDisplayParts } from "@prism/core";

const eventKey = /(?:At|_at)$/;
const boundaryKeys = new Set(["at", "from", "to", "start", "end"]);
// Rule definitions, user-controlled metadata and credentials are not event transport fields.
const untouchedKeys = new Set(["billingSnapshot", "provider", "dateTimeRange", "timeRange", "ruleTimeRange", "metadata", "store", "homeAssistantConnection", "ttLockConnection", "hinataIoDevices", "pricingExplanation"]);
const isEventKey = (key: string) => eventKey.test(key) || boundaryKeys.has(key);

export function hasEventTimestamps(value: unknown, key = ""): boolean {
  if (untouchedKeys.has(key)) return false;
  if (isEventKey(key) && isApiInstant(value)) return true;
  if (Array.isArray(value)) return value.some(item => hasEventTimestamps(item));
  return !!value && typeof value === "object" && Object.entries(value).some(([name, item]) => hasEventTimestamps(item, name));
}

/** Project event instants at the response boundary, without touching saved rules or receipts. */
export function projectApiTimes(value: unknown, timeZone: string, key = ""): unknown {
  // A long bill repeats the same boundaries across segments, tracks and players.
  // Keep this memo inside one response so time/zone changes never reuse old values.
  const instants = new Map<string, string>();
  return project(value, key);

  function project(value: unknown, key = ""): unknown {
    if (untouchedKeys.has(key)) return value;
    if (isEventKey(key) && isApiInstant(value)) {
      let formatted = instants.get(value);
      if (formatted === undefined) {
        formatted = formatOffsetTimestamp(value, timeZone);
        instants.set(value, formatted);
      }
      return formatted;
    }
    if (Array.isArray(value)) return value.map(item => project(item));
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, project(item, name)]));
    // Keep legacy display labels consistent while updated clients derive their own labels from instants.
    if (isApiInstant(result.at) && Array.isArray(result.entries)) {
      const parts = timestampDisplayParts(result.at)!;
      result.time = parts.time;
      result.date = parts.date;
    }
    if ("periodLabel" in result && isApiInstant(result.startedAt) && isApiInstant(result.endedAt)) {
      const start = timestampDisplayParts(result.startedAt)!, end = timestampDisplayParts(result.endedAt)!;
      result.periodLabel = `${start.date === end.date ? "" : `${start.date} `}${start.time} – ${start.date === end.date ? "" : `${end.date} `}${end.time}`;
    }
    return result;
  }
}
