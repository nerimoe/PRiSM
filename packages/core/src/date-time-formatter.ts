/** Cache formatter configuration, never an offset: DST still follows each instant. */
export function dateTimeFormatterCache(options: Intl.DateTimeFormatOptions) {
  const cache = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string) => {
    let formatter = cache.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    } else cache.delete(timeZone);
    cache.set(timeZone, formatter);
    return formatter;
  };
}
