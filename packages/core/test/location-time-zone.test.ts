import { expect, test } from "bun:test";
import { resolveLocationTimeZone } from "../src/location-time-zone";

test("store coordinates resolve to geographic IANA zones rather than longitude offsets", () => {
  for (const [lat, lng, zone] of [
    [31.2304, 121.4737, "Asia/Shanghai"],
    [35.6812, 139.7671, "Asia/Tokyo"],
    [40.7128, -74.0060, "America/New_York"],
    [51.5074, -0.1278, "Europe/London"],
    [27.7172, 85.3240, "Asia/Kathmandu"],
    [43.2389, 76.8897, "Asia/Almaty"],
  ] as const) {
    expect(resolveLocationTimeZone(lat, lng)).toBe(zone);
  }
});

test("IANA zones preserve seasonal and fractional UI offsets", () => {
  const ny = resolveLocationTimeZone(40.7128, -74.0060);
  const clock = (at: string, timeZone: string) => new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(at));
  expect(clock("2026-01-01T12:00:00Z", ny)).toBe("07:00");
  expect(clock("2026-07-01T12:00:00Z", ny)).toBe("08:00");
  expect(clock("2026-01-01T12:00:00Z", resolveLocationTimeZone(27.7172, 85.3240))).toBe("17:45");
});

test("invalid or incomplete locations cannot silently choose a time zone", () => {
  for (const [latitude, longitude] of [[91, 0], [0, -181], [NaN, 0], [0, Infinity]]) {
    expect(() => resolveLocationTimeZone(latitude!, longitude!)).toThrow(RangeError);
  }
});
