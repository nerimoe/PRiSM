import { expect, test } from "bun:test";
import { billPeriod, billTime } from "../src/ui/bill-time";

test("bill timestamps render in the selected UI zone without changing the instant", () => {
  const at = "2026-10-02T02:08:00.000Z";
  expect(billTime(at, "UTC")).toMatchObject({ date: "2026-10-02", time: "02:08" });
  expect(billTime(at, "Asia/Shanghai")).toMatchObject({ date: "2026-10-02", time: "10:08" });
  expect(billTime(at, "America/New_York")).toMatchObject({ date: "2026-10-01", time: "22:08" });
});

test("UI dates and periods use the same zone through midnight and year boundaries", () => {
  expect(billPeriod("2026-10-02T15:00:00Z", "2026-10-02T17:00:00Z", "Asia/Shanghai"))
    .toBe("10-02 23:00 – 10-03 01:00");
  expect(billPeriod("2026-12-31T15:00:00Z", "2026-12-31T17:00:00Z", "Asia/Shanghai"))
    .toBe("2026-12-31 23:00 – 2027-01-01 01:00");
  expect(billPeriod("2026-10-02T02:08:00Z", "2026-10-02T03:54:00Z", "Asia/Shanghai"))
    .toBe("10:08 – 11:54");
});

test("the same response displays merchant shop time or player device time without shifting the instant", () => {
  const at = "2026-10-03T10:08:00+08:00";
  expect(billTime(at, "Asia/Shanghai").time).toBe("10:08");
  expect(billTime(at, "Asia/Tokyo").time).toBe("11:08");
  expect(billTime(at).time).toBe(billTime(at, Intl.DateTimeFormat().resolvedOptions().timeZone).time);
  expect(billPeriod("2026-10-03T23:50:00+08:00", "2026-10-04T00:10:00+08:00", "Asia/Shanghai")).toBe("10-03 23:50 – 10-04 00:10");
});

test("rollback labels distinguish repeated wall-clock times", () => {
  expect(billPeriod("2026-11-01T01:10:00-04:00", "2026-11-01T01:20:00-05:00", "America/New_York")).toBe("01:10 UTC-04:00 – 01:20 UTC-05:00");
});
