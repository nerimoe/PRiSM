import { expect, test } from "bun:test";
import { billPeriod, billTime } from "../src/ui/bill-time";

test("bill timestamps render in the selected UI zone without changing the instant", () => {
  const at = "2026-10-02T02:08:00.000Z";
  expect(billTime(at, "UTC")).toEqual({ date: "2026-10-02", time: "02:08" });
  expect(billTime(at, "Asia/Shanghai")).toEqual({ date: "2026-10-02", time: "10:08" });
  expect(billTime(at, "America/New_York")).toEqual({ date: "2026-10-01", time: "22:08" });
});

test("UI dates and periods use the same zone through midnight and year boundaries", () => {
  expect(billPeriod("2026-10-02T15:00:00Z", "2026-10-02T17:00:00Z", "Asia/Shanghai"))
    .toBe("10-02 23:00 – 10-03 01:00");
  expect(billPeriod("2026-12-31T15:00:00Z", "2026-12-31T17:00:00Z", "Asia/Shanghai"))
    .toBe("2026-12-31 23:00 – 2027-01-01 01:00");
  expect(billPeriod("2026-10-02T02:08:00Z", "2026-10-02T03:54:00Z", "Asia/Shanghai"))
    .toBe("10:08 – 11:54");
});
