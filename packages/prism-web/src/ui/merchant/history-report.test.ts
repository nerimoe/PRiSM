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

  it("counts overlapping sessions once, carries overnight presence and excludes exact end boundaries", () => {
    const source = facts();
    source.sessionRows = [
      { player_id: "a", started_at: "2026-10-31T14:00:00Z", ended_at: "2026-10-31T17:00:00Z" },
      { player_id: "a", started_at: "2026-10-31T15:30:00Z", ended_at: "2026-10-31T16:30:00Z" },
      { player_id: "b", started_at: "2026-11-01T14:30:00Z", ended_at: "2026-11-01T15:30:00Z" },
    ];
    const result = historyTraffic(source);
    expect(result.entries[0]).toBe(1);
    expect(result.entries[23]).toBe(1);
    expect(result.presence[0]).toBe(2);
    expect(result.presence[1]).toBe(1);
    expect(result.presence[2]).toBe(0);
    expect(result.presence[23]).toBe(1);
  });

  it("clips open sessions to the server observation time", () => {
    const source = facts();
    source.asOf = "2026-10-31T16:30:00Z";
    source.sessionRows = [{ player_id: "a", started_at: "2026-10-31T15:00:00Z", ended_at: null }];
    expect(historyTraffic(source).presence.slice(0, 3)).toEqual([1, 1, 0]);
  });

  it("computes monetary summaries in integer cents before conversion and creates a readable xlsx", async () => {
    const source = facts();
    source.checkoutRows = [1001, 2002].map((total, i) => ({ id: `${i}`, player_id: "p", total,
      settled_at: "2026-11-01T03:00:00Z", duration_minutes: 60, payment_method: "cash" }));
    const analytics = calculateHistoryAnalytics(source);
    expect(analytics.period.revenueTotal).toBe(30.03);
    expect(analytics.period.avgTicket).toBe(15.02);
    expect(analytics.daily[0]!.revenue).toBe(30.03);
    expect(analytics.paymentMethods[0]!.revenue).toBe(30.03);
    const bytes = await createHistoryWorkbook({ analytics, traffic: historyTraffic(source), records: [], archive: "active", deviceNames: new Map() });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.worksheets).toHaveLength(6);
    expect(workbook.getWorksheet("每日趋势")!.getCell("B2").value).toBe(30.03);
    expect(workbook.getWorksheet("时段分布")!.rowCount).toBe(25);
    expect(workbook.getWorksheet("结账记录")!.rowCount).toBe(1);
  });

  it("exports every page using the same time range and archive selection", async () => {
    const paths: string[] = [];
    const result = await loadExportCheckouts(async path => {
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
