/** Render absolute API timestamps in the UI's selected time zone. */
export function billTime(at: string, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at));
  const value = (name: string) => parts.find(part => part.type === name)!.value;
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
}

export function billPeriod(startedAt: string, endedAt: string, timeZone?: string): string {
  const start = billTime(startedAt, timeZone), end = billTime(endedAt, timeZone);
  if (start.date === end.date) return `${start.time} – ${end.time}`;
  const sameYear = start.date.slice(0, 4) === end.date.slice(0, 4);
  return `${sameYear ? start.date.slice(5) : start.date} ${start.time} – ${sameYear ? end.date.slice(5) : end.date} ${end.time}`;
}
