import { describe, expect, it } from "vitest";
import type { StaffReportsAnalyticsSource, StaffReportCheckout } from "@prism/application";
import ExcelJS from "exceljs";
import { historyPresetRange } from "./history-range";
import { historyTraffic } from "./history-traffic";
import { calculateHistoryAnalytics } from "./history-analytics";
import { createHistoryWorkbook, loadExportCheckouts } from "./history-export";

function facts(): StaffReportsAnalyticsSource {
  return {
    range: { days: 2, timeZone: "Asia/Tokyo", from: "2026-10-31T15:00:00Z", to: "2026-11-02T15:00:00Z", startDate: "2026-11-01", endDate: "2026-11-02" },
    asOf: "2026-11-03T00:00:00Z", checkoutRows: [], sessionRows: [], playerRows: [], operationRows: [], assetGrantCount: 0,
  };
}

describe("history report", () => {
  it("uses complete previous calendar months, including leap years and year rollover", () => {
    for (const [today, from, to] of [
      ["2026-05-23", "2026-04-01", "2026-04-30"],
      ["2026-12-01", "2026-11-01", "2026-11-30"],
      ["2026-02-28", "2026-01-01", "2026-01-31"],
      ["2026-03-01", "2026-02-01", "2026-02-28"],
      ["2024-03-31", "2024-02-01", "2024-02-29"],
      ["2026-01-01", "2025-12-01", "2025-12-31"],
    ]) expect(historyPresetRange(today!, "lastMonth")).toEqual({ from, to });
    expect(historyPresetRange("2026-11-23", 7)).toEqual({ from: "2026-11-17", to: "2026-11-23" });
  });

  it("counts overlapping sessions once, clips zombie presence at the stay cap, and excludes exact end boundaries", () => {
    const source = facts();
    source.sessionRows = [
      // Player a checked in before midnight JST and left at 02:00 JST.
      { player_id: "a", started_at: "2026-10-31T14:00:00Z", ended_at: "2026-10-31T17:00:00Z" },
      { player_id: "a", started_at: "2026-10-31T15:30:00Z", ended_at: "2026-10-31T16:30:00Z" },
      { player_id: "b", started_at: "2026-11-01T14:30:00Z", ended_at: "2026-11-01T15:30:00Z" },
      // Forgotten checkout across the whole range -> clipped at the shop's stay cap.
      { player_id: "zombie", started_at: "2026-10-31T16:00:00Z", ended_at: "2026-11-02T14:00:00Z" },
    ];
    // Default cap is 12h: the zombie counts from 01:00 to 13:00 JST on day 1, then stops.
    const byDefault = historyTraffic(source);
    expect(byDefault.clippedSessionCount).toBe(1);
    expect(byDefault.presence.totals[12]).toBe(1);
    expect(byDefault.presence.totals[13]).toBe(0);

    // A shop that sets the cap to 1h clips it at start + 1h (17:00Z = 02:00 JST Nov 1); player a's
    // 3h stay is clipped too, but a's overlapping second session keeps a present through hour 01.
    source.stayCapHours = 1;
    const result = historyTraffic(source);
    expect(result.clippedSessionCount).toBe(2);
    expect(result.entries.days).toBe(2);
    expect(result.entries.totals[0]).toBe(1); // player a started at 00:30 JST day 1
    expect(result.entries.totals[1]).toBe(1); // zombie started at 01:00 JST day 1
    expect(result.entries.totals[23]).toBe(1); // player b started at 23:30 JST day 1
    expect(result.presence.totals[0]).toBe(2); // player a (day 1) + player b (day 2)
    expect(result.presence.averages[0]).toBe(1); // 2 / 2 days
    expect(result.presence.medians[0]).toBe(1); // [1, 1] -> median 1
    expect(result.presence.totals[1]).toBe(2); // player a + zombie (clipped to 02:00 JST) on day 1
    expect(result.presence.totals[2]).toBe(0); // zombie excluded from hour 02+
    expect(result.presence.totals[23]).toBe(1); // player b on day 2 23:30 JST
  });

  it("computes multi-day average, median, and peak per hour while capping to observed dates", () => {
    const source = facts();
    source.range = {
      days: 4,
      timeZone: "Asia/Tokyo",
      from: "2026-10-31T15:00:00Z",
      to: "2026-11-04T15:00:00Z",
      startDate: "2026-11-01",
      endDate: "2026-11-04",
    };
    // Only Nov 1, Nov 2, Nov 3 have elapsed (Nov 4 is in the future).
    source.asOf = "2026-11-03T14:00:00Z"; // 2026-11-03 23:00 JST
    source.sessionRows = [
      // Hour 19 JST on Nov 1 (2 players), Nov 2 (4 players), Nov 3 (0 players) -> [2, 4, 0] -> avg 2, median 2, max 4
      { player_id: "p1", started_at: "2026-11-01T10:00:00Z", ended_at: "2026-11-01T11:00:00Z" },
      { player_id: "p2", started_at: "2026-11-01T10:15:00Z", ended_at: "2026-11-01T10:45:00Z" },
      { player_id: "p1", started_at: "2026-11-02T10:00:00Z", ended_at: "2026-11-02T10:50:00Z" },
      { player_id: "p2", started_at: "2026-11-02T10:10:00Z", ended_at: "2026-11-02T10:50:00Z" },
      { player_id: "p3", started_at: "2026-11-02T10:20:00Z", ended_at: "2026-11-02T10:50:00Z" },
      { player_id: "p4", started_at: "2026-11-02T10:30:00Z", ended_at: "2026-11-02T10:50:00Z" },
    ];
    const traffic = historyTraffic(source);
    expect(traffic.entries.days).toBe(3);
    expect(traffic.entries.buckets[19]).toEqual({
      hour: 19,
      total: 6,
      avg: 2,
      median: 2,
      max: 4,
      activeDays: 2,
    });
  });

  it("clips open sessions to the server observation time", () => {
    const source = facts();
    source.asOf = "2026-10-31T16:30:00Z";
    source.sessionRows = [
      { player_id: "a", started_at: "2026-10-31T15:00:00Z", ended_at: null },
    ];
    expect(historyTraffic(source).presence.totals.slice(0, 3)).toEqual([1, 1, 0]);
  });

  it("computes effective stay durations, medians, and coin-only topDevices, and creates a readable xlsx", async () => {
    const source = facts();
    source.checkoutRows = [
      { id: "c1", player_id: "p1", total: 1001, settled_at: "2026-11-01T03:00:00Z", duration_minutes: 60, payment_method: "cash" },
      { id: "c2", player_id: "p2", total: 2002, settled_at: "2026-11-01T05:00:00Z", duration_minutes: 120, payment_method: "cash" },
      // Outlier: forgot to checkout for 3 days (4320 min raw) -> 720 min effective (12h cap), 3600 min inactive.
      { id: "c3", player_id: "p3", total: 9000, settled_at: "2026-11-02T05:00:00Z", duration_minutes: 4320, payment_method: "wechat" },
    ];
    source.sessionRows = [
      { player_id: "p1", checkout_id: "c1", started_at: "2026-11-01T02:00:00Z", ended_at: "2026-11-01T03:00:00Z" },
      { player_id: "p2", checkout_id: "c2", started_at: "2026-11-01T03:00:00Z", ended_at: "2026-11-01T05:00:00Z" },
      { player_id: "p3", checkout_id: "c3", started_at: "2026-10-30T05:00:00Z", ended_at: "2026-11-02T05:00:00Z" },
    ];
    source.operationRows = [
      // swipe-only device (0 coins) must be excluded from coin-sorted topDevices
      ...Array.from({ length: 10 }, (_, i) => ({
        device_id: "door_or_reader",
        action: "aime.scan",
        status: "succeeded",
        counts_as_play: 1,
        requested_at: `2026-11-01T02:0${i % 9}:00Z`,
      })),
      // cab_b has more operations (6 swipes + 1 coin = 7) than cab_a (3 coins), but cab_a must rank #1 by coins
      ...Array.from({ length: 6 }, (_, i) => ({
        device_id: "cab_b",
        action: "aime.scan",
        status: "succeeded",
        counts_as_play: 1,
        requested_at: `2026-11-01T03:0${i}:00Z`,
      })),
      { device_id: "cab_b", action: "coin", status: "succeeded", counts_as_play: 1, requested_at: "2026-11-01T03:10:00Z" },
      { device_id: "cab_a", action: "coin", status: "succeeded", counts_as_play: 1, requested_at: "2026-11-01T04:01:00Z" },
      { device_id: "cab_a", action: "coin", status: "succeeded", counts_as_play: 1, requested_at: "2026-11-01T04:02:00Z" },
      { device_id: "cab_a", action: "coin", status: "succeeded", counts_as_play: 1, requested_at: "2026-11-01T04:03:00Z" },
      ...Array.from({ length: 4 }, (_, i) => ({
        device_id: "entry_qr",
        action: "resource.visited",
        status: "succeeded",
        counts_as_play: 0,
        requested_at: `2026-11-01T01:0${i}:00Z`,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        device_id: "cab_a",
        action: "resource.visited",
        status: "succeeded",
        counts_as_play: 0,
        requested_at: `2026-11-01T04:1${i}:00Z`,
      })),
    ];

    const analytics = calculateHistoryAnalytics(source);
    expect(analytics.period.revenueTotal).toBe(120.03);
    expect(analytics.period.avgTicket).toBe(40.01);
    expect(analytics.period.medianTicket).toBe(20.02);
    // Effective stay durations: [60, 120, 720] -> median 120 (the outlier barely moves it), avg 300;
    // total effective 900, inactive 3600 (1 checkout)
    expect(analytics.period.medianDurationMinutes).toBe(120);
    expect(analytics.period.avgDurationMinutes).toBe(300);
    expect(analytics.period.totalEffectiveDurationMinutes).toBe(900);
    expect(analytics.period.totalInactiveDurationMinutes).toBe(3600);
    expect(analytics.period.inactiveCheckoutCount).toBe(1);
    expect(analytics.topDevices).toMatchObject([
      { deviceId: "cab_a", operations: 3, coins: 3, swipes: 0, visits: 2 },
      { deviceId: "cab_b", operations: 7, coins: 1, swipes: 6, visits: 0 },
    ]);

    // Heat folds hints within 3 minutes into one play, so 10 rapid reader swipes count as 3 plays
    // and coin-only, swipe-only and visit-only devices land on one scale.
    expect(analytics.topDevicesByHeat.map((d) => [d.deviceId, d.plays])).toEqual([
      ["door_or_reader", 3],
      ["cab_b", 3],
      ["cab_a", 2],
      ["entry_qr", 2],
    ]);

    const bytes = await createHistoryWorkbook({
      analytics,
      traffic: historyTraffic(source),
      records: [],
      archive: "active",
      deviceNames: new Map([["door_or_reader", "前台读卡器"]]),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets).toHaveLength(6);
    expect(workbook.getWorksheet("每日趋势")!.getCell("B2").value).toBe(30.03);
    expect(workbook.getWorksheet("时段分布")!.rowCount).toBe(25);
    expect(workbook.getWorksheet("时段分布")!.getRow(1).values).toContain("在场中位数（人）");
    expect(workbook.getWorksheet("热门资源")!.getRow(1).values).toEqual([undefined, "排名", "资源", "综合热度（去重游玩次数）"]);
    expect(workbook.getWorksheet("热门资源")!.getRow(2).values).toEqual([undefined, 1, "前台读卡器", 3]);
    expect(workbook.getWorksheet("结账记录")!.rowCount).toBe(1);

  });

  it("exports every page using the same time range and archive selection", async () => {
    const paths: string[] = [];
    const result = await loadExportCheckouts(async (path) => {
      paths.push(path);
      return { records: [{ checkoutId: String(paths.length) } as StaffReportCheckout], page: { hasMore: paths.length < 2 } };
    }, "from=start&to=end", "archived");
    expect(result).toHaveLength(2);
    expect(paths).toEqual([
      "reports/checkouts?from=start&to=end&archive=archived&limit=50&offset=0",
      "reports/checkouts?from=start&to=end&archive=archived&limit=50&offset=50",
    ]);
  });
});
