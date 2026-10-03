import { expect, test } from "bun:test";
import { formatOffsetTimestamp, timestampDisplayParts } from "../src";

test("China and Japan offsets preserve the same instant, milliseconds and idempotent projection", () => {
  const at = "2026-10-03T02:08:00.123Z";
  const shanghai = formatOffsetTimestamp(at, "Asia/Shanghai");
  const tokyo = formatOffsetTimestamp(at, "Asia/Tokyo");
  expect(shanghai).toBe("2026-10-03T10:08:00.123+08:00");
  expect(tokyo).toBe("2026-10-03T11:08:00.123+09:00");
  expect(Date.parse(shanghai)).toBe(Date.parse(at));
  expect(Date.parse(tokyo)).toBe(Date.parse(at));
  expect(formatOffsetTimestamp(shanghai, "Asia/Shanghai")).toBe(shanghai);
  expect(timestampDisplayParts(tokyo)?.time).toBe("11:08");
});

test("offsets follow each timestamp's seasonal rules and preserve duration through clock rollback", () => {
  expect(formatOffsetTimestamp("2026-01-01T12:00:00Z", "America/New_York")).toBe("2026-01-01T07:00:00.000-05:00");
  expect(formatOffsetTimestamp("2026-07-01T12:00:00Z", "America/New_York")).toBe("2026-07-01T08:00:00.000-04:00");
  const start = formatOffsetTimestamp("2026-11-01T05:10:00Z", "America/New_York");
  const end = formatOffsetTimestamp("2026-11-01T06:20:00Z", "America/New_York");
  expect((Date.parse(end) - Date.parse(start)) / 60000).toBe(70);
  expect(timestampDisplayParts(start)?.offset).toBe("-04:00");
  expect(timestampDisplayParts(end)?.offset).toBe("-05:00");
});
