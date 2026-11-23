import type { ReportArchiveFilter, StaffReportCheckout } from "@prism/application";
import type { DashboardAnalytics } from "./dashboard-metrics";
import type { HistoryTrafficResult } from "./history-traffic";
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
  traffic: HistoryTrafficResult;
  records: StaffReportCheckout[];
  archive: ReportArchiveFilter;
  deviceNames: ReadonlyMap<string, string>;
  excludedPlayers?: string[];
  excludeStaff?: boolean;
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
    ws.columns.forEach((column) => {
      column.width = 24;
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: headers.length } };
    return ws;
  }
  sheet("统计概览", ["指标", "数值"], [
    ["开始日期", a.range.startDate],
    ["结束日期（含）", a.range.endDate],
    ["门店时区", a.range.timeZone],
    ["结账记录筛选", input.archive],
    ["自动排除店员", input.excludeStaff ? "是" : "否"],
    ["已排除玩家", (input.excludedPlayers ?? []).join("、")],
    ["统计口径", "经营统计排除归档账单；结账明细按所选归档筛选导出"],
    ["营业额（元）", a.period.revenueTotal],
    ["结账笔数", a.period.checkoutCount],
    ["客单价中位数（元）", a.period.medianTicket],
    ["平均客单价（元）", a.period.avgTicket],
    ["客流（玩家日）", a.period.visitCount],
    ["活跃玩家", a.period.uniquePlayerCount],
    ["新注册玩家", a.period.newPlayerCount],
    ["中位有效在店时长（分钟）", a.period.medianDurationMinutes],
    ["平均有效在店时长（分钟）", a.period.avgDurationMinutes],
    ["有效在店总时长（分钟）", a.period.totalEffectiveDurationMinutes],
    ["无效挂机总时长（分钟）", a.period.totalInactiveDurationMinutes],
    ["含无效尾段账单数", a.period.inactiveCheckoutCount],
    ["投币次数", a.period.coinCount],
    ["资产入账笔数", a.period.assetGrantCount],
    ["时长口径", "每段计时从开始计至最后一次玩家操作或设备事件后 1 小时（不超过实际结束时间），超出部分记为无效挂机时长"],
    ["时段口径", "每时段按玩家和自然日去重，计算日均与日分布中位数；在场仅统计有效在店区间"],
  ]);
  const daily = sheet(
    "每日趋势",
    ["日期", "营收（元）", "结账笔数", "客流", "投币次数"],
    a.daily.map((p) => [p.date, p.revenue, p.checkouts, p.visits, p.coins]),
  );
  daily.getColumn(2).numFmt = "0.00";
  sheet(
    "时段分布",
    [
      "时段（门店时间）",
      "入场日均（人）",
      "入场中位数（人）",
      "入场累计（人次）",
      "在场日均（人）",
      "在场中位数（人）",
      "在场峰值（人）",
      "在场累计（人次）",
    ],
    Array.from({ length: 24 }, (_, hour) => {
      const entry = input.traffic.entries.buckets[hour];
      const present = input.traffic.presence.buckets[hour];
      return [
        `${String(hour).padStart(2, "0")}:00`,
        entry?.avg ?? 0,
        entry?.median ?? 0,
        entry?.total ?? 0,
        present?.avg ?? 0,
        present?.median ?? 0,
        present?.max ?? 0,
        present?.total ?? 0,
      ];
    }),
  );
  const payments = sheet(
    "收款方式",
    ["方式", "营收（元）", "笔数"],
    a.paymentMethods.map((p) => [p.method, p.revenue, p.count]),
  );
  payments.getColumn(2).numFmt = "0.00";
  sheet(
    "热门资源",
    ["排名", "资源", "综合热度（去重游玩次数）"],
    a.topDevicesByHeat.map((p, index) => [index + 1, input.deviceNames.get(p.deviceId) ?? p.deviceId, p.plays]),
  );
  const records = sheet(
    "结账记录",
    ["账单编号", "玩家", "结账时间（门店时间）", "累计时长（分钟）", "计时数", "金额（元）", "收款方式", "已归档"],
    input.records.map((r) => [
      r.checkoutId,
      r.playerDisplayName,
      displayDateTime(r.settledAt, a.range.timeZone),
      r.durationMinutes,
      r.sessionCount,
      r.total,
      r.externalPayment?.method ?? "资产结算",
      r.archived ? "是" : "否",
    ]),
  );
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
