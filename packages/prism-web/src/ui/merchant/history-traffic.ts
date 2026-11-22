import type { StaffReportsAnalyticsSource } from "@prism/application";

/** Distinct player-days per local hour; concurrent resource sessions never double count. */
export function historyTraffic(source: StaffReportsAnalyticsSource) {
  const entries = Array.from({ length: 24 }, () => new Set<string>());
  const presence = Array.from({ length: 24 }, () => new Set<string>());
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: source.range.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = (stamp: number) => {
    const values = Object.fromEntries(formatter.formatToParts(stamp).map(p => [p.type, p.value]));
    return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour), minute: Number(values.minute) };
  };
  const instant = (value: string) => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value);
  const from = Date.parse(source.range.from);
  const to = Math.min(Date.parse(source.range.to), Date.parse(source.asOf));
  const byPlayer = new Map<string, [number, number][]>();
  for (const row of source.sessionRows) {
    const start = instant(row.started_at);
    const end = row.ended_at ? instant(row.ended_at) : to;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start >= from && start < to) {
      const local = parts(start);
      entries[local.hour]!.add(`${local.date}:${row.player_id}`);
    }
    const a = Math.max(start, from), b = Math.min(end, to);
    if (a >= b) continue;
    const intervals = byPlayer.get(row.player_id) ?? [];
    intervals.push([a, b]);
    byPlayer.set(row.player_id, intervals);
  }
  for (const [player, intervals] of byPlayer) {
    intervals.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    for (const [a, b] of merged) {
      for (let stamp = a; stamp < b;) {
        const local = parts(stamp);
        presence[local.hour]!.add(`${local.date}:${player}`);
        stamp = Math.floor(stamp / 60_000) * 60_000 + (60 - local.minute) * 60_000;
      }
    }
  }
  return { entries: entries.map(s => s.size), presence: presence.map(s => s.size) };
}
