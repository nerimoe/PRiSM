import type { ReportArchiveFilter, StaffReportCheckout } from "@prism/application";
import type { DashboardAnalytics } from "./dashboard-metrics";
import { displayDateTime } from "../bill-time";

export async function loadExportCheckouts(
  request: (path: string) => Promise<{ records: StaffReportCheckout[]; page: { hasMore: boolean } }>,
  range: string,
  archive: ReportArchiveFilter,
) {
  const records: StaffReportCheckout[] = [];
  for (let offset = 0; ; offset += 50) {
    const page = await request(`reports/checkouts?${range}&archive=${archive}&limit=50&offset=${offset}`);
    records.push(...page.records);
    if (!page.page.hasMore) return records;
    if (!page.records.length) throw new Error("导出记录加载不完整，请重试");
  }
}

export async function createHistoryWorkbook(input: {
  analytics: DashboardAnalytics;
  traffic: { entries: number[]; presence: number[] };
  records: StaffReportCheckout[];
  archive: ReportArchiveFilter;
  deviceNames: ReadonlyMap<string, string>;
}) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PRiSM";
  const { analytics: a } = input;
  function sheet(name: string, headers: string[], rows: (string | number | null)[][]) {
    const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(headers);
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0066D6" } };
    ws.columns.forEach(column => { column.width = 24; });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: headers.length } };
    return ws;
  }
  sheet("统计概览", ["指标", "数值"], [
    ["开始日期", a.range.startDate], ["结束日期（含）", a.range.endDate], ["门店时区", a.range.timeZone],
    ["结账记录筛选", input.archive], ["统计口径", "经营统计排除归档账单；结账明细按所选归档筛选导出"],
    ["营业额（元）", a.period.revenueTotal], ["结账笔数", a.period.checkoutCount],
    ["客流（玩家日）", a.period.visitCount], ["活跃玩家", a.period.uniquePlayerCount],
    ["新注册玩家", a.period.newPlayerCount], ["平均在店时长（分钟）", a.period.avgDurationMinutes],
    ["投币次数", a.period.coinCount], ["资产入账笔数", a.period.assetGrantCount],
    ["时段口径", "每时段按玩家和自然日去重；在场以计时区间为准，跨时段分别计入"],
  ]);
  const daily = sheet("每日趋势", ["日期", "营收（元）", "结账笔数", "客流", "投币次数"],
    a.daily.map(p => [p.date, p.revenue, p.checkouts, p.visits, p.coins]));
  daily.getColumn(2).numFmt = "0.00";
  sheet("时段分布", ["时段（门店时间）", "入场人次", "在场人次"],
    input.traffic.entries.map((count, hour) => [`${String(hour).padStart(2, "0")}:00`, count, input.traffic.presence[hour] ?? 0]));
  const payments = sheet("收款方式", ["方式", "营收（元）", "笔数"], a.paymentMethods.map(p => [p.method, p.revenue, p.count]));
  payments.getColumn(2).numFmt = "0.00";
  sheet("热门资源", ["资源", "操作次数", "投币次数", "刷卡次数"],
    a.topDevices.map(p => [input.deviceNames.get(p.deviceId) ?? p.deviceId, p.operations, p.coins, p.swipes]));
  const records = sheet("结账记录", ["账单编号", "玩家", "结账时间（门店时间）", "累计时长（分钟）", "计时数", "金额（元）", "收款方式", "已归档"],
    input.records.map(r => [r.checkoutId, r.playerDisplayName, displayDateTime(r.settledAt, a.range.timeZone),
      r.durationMinutes, r.sessionCount, r.total, r.externalPayment?.method ?? "资产结算", r.archived ? "是" : "否"]));
  records.getColumn(6).numFmt = "0.00";
  return workbook.xlsx.writeBuffer();
}

export function downloadHistoryWorkbook(bytes: ArrayBuffer, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
