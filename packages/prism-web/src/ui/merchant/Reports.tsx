import type {
  StaffReportsAnalyticsSource,
  ReportArchiveFilter,
  StaffReportCheckout,
  StaffReportCheckoutDetail,
} from "@prism/application";
import { addLocalDays, formatLocalDate, parseLocalDateTime } from "@prism/core";
import { Clock, Coins, Download, RefreshCw, Users, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Api, api, type Resource } from "../../api";
import { useI18n } from "../../i18n";
import { ShopOperationHistory } from "./OperationHistory";
import { shopApi } from "../BillingPages";
import { BillTimeline, BillTotal } from "../BillTimeline";
import { displayDateTime } from "../bill-time";
import {
  DeltaBadge,
  HourlyTrafficChart,
  PaymentBreakdownCard,
  RevenueTrendChart,
  TopDevicesCard,
} from "./DashboardCharts";
import {
  deltaIndicator,
  diffLocalDays,
  formatDurationSummary,
  peakHourSummary,
  type DashboardAnalytics,
} from "./dashboard-metrics";
import {
  Modal,
  State,
  Table,
  button,
  cell,
  money,
  primary,
  segment,
  useMerchant,
  useResource,
  useStaffApi,
} from "./shared";

import { historyPresetRange, type HistoryPreset as RangePreset } from "./history-range";
import { calculateHistoryAnalytics } from "./history-analytics";
import { historyTraffic, type HistoryTrafficResult } from "./history-traffic";

// Explicit state assignment is idempotent; it is not a debit operation.
const setReportArchive = (
  shopCode: string,
  checkoutId: string,
  archived: boolean,
) =>
  api(
    shopApi(shopCode, `staff/reports/checkouts/${segment(checkoutId)}/archive`),
    {
      method: "POST",
      body: JSON.stringify({ archived }),
    },
  );

export function payment(record: StaffReportCheckout, t: (key: string) => string) {
  return record.externalPayment
    ? `${t("现场收款")} · ${t(({ wechat: "微信", alipay: "支付宝", cash: "现金", other: "其他" } as Record<string, string>)[record.externalPayment.method] ?? record.externalPayment.method)}`
    : t("资产结算");
}

export function ReportsPage() {
  const { shopId } = useMerchant();
  return <ReportsContent key={shopId} />;
}

function ReportsContent() {
  const { t, errorText } = useI18n();
  const { shopId, shopCode, timeZone } = useMerchant();
  const request = useStaffApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "operations" ? "operations" : "overview";
  const setView = (next: "overview" | "operations") => {
    const updated = new URLSearchParams(searchParams);
    if (next === "operations") updated.set("view", "operations");
    else updated.delete("view");
    setSearchParams(updated, { replace: true });
  };
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const playerOptions = useResource<{ excludedPlayerIds: string[] }>("reports/exclusions");
  const excludedIds = playerOptions.data?.excludedPlayerIds ?? [];
  const exclusionKey = JSON.stringify(excludedIds);
  const exclusionQuery = `excludePlayers=${encodeURIComponent(exclusionKey)}`;
  useEffect(() => { setOffset(0); }, [exclusionKey]);
  const [preset, setPreset] = useState<RangePreset>(7);
  const [from, setFrom] = useState(() =>
    addLocalDays(formatLocalDate(new Date(), timeZone), -6),
  );
  const [to, setTo] = useState(() => formatLocalDate(new Date(), timeZone));
  const [archive, setArchive] = useState<ReportArchiveFilter>("active");
  const [offset, setOffset] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [devices, setDevices] = useState<Resource[] | null>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);

  const start = from
    ? parseLocalDateTime(from, "00:00", timeZone)
    : new Date(NaN);
  const end = to
    ? parseLocalDateTime(addLocalDays(to, 1), "00:00", timeZone)
    : new Date(NaN);
  const valid =
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start < end;
  const spanDays = valid ? diffLocalDays(from, to) + 1 : 0;
  const analyticsTooLong = valid && spanDays > 366;
  const range = valid
    ? new URLSearchParams({
        from: start.toISOString(),
        to: end.toISOString(),
      }).toString()
    : "";

  const recordsRange = archive === "active" ? `${range}&${exclusionQuery}` : range;
  const analyticsPath =
    !valid || analyticsTooLong || !playerOptions.data
      ? null
      : `reports/analytics?source=1&startDate=${from}&endDate=${to}&${exclusionQuery}`;
  const analyticsResource = useResource<{ source: StaffReportsAnalyticsSource }>(analyticsPath);
  const source = analyticsPath && analyticsResource.data?.source.range.startDate === from && analyticsResource.data.source.range.endDate === to && JSON.stringify(analyticsResource.data.source.excludedPlayerIds ?? []) === exclusionKey
    ? analyticsResource.data.source : null;
  const analytics = useMemo(() => source ? calculateHistoryAnalytics(source) : null, [source]);
  const traffic = useMemo<HistoryTrafficResult | null>(() => source ? historyTraffic(source) : null, [source]);
  const analyticsError = playerOptions.error ? errorText(playerOptions.error) : analyticsTooLong
    ? t("自定义图表最多支持 366 天，结账记录不受限制。")
    : analyticsPath && analyticsResource.error
      ? errorText(analyticsResource.error)
      : "";
  const analyticsLoading = Boolean(analyticsPath) && !analytics && !analyticsError;

  const loadDevices = useCallback(async () => {
    try {
      const result = await Api.machines(shopId);
      setDevices(result.machines ?? []);
    } catch {
      // Keep raw device IDs as fallback if the inventory endpoint fails or is omitted.
    }
  }, [shopId]);

  useEffect(() => {
    setDevices(null);
    void loadDevices();
  }, [loadDevices]);

  function selectPreset(next: RangePreset) {
    setOffset(0);
    if (next === "custom") {
      setPreset("custom");
      return;
    }
    const today = formatLocalDate(new Date(), timeZone);
    setPreset(next);
    const dates = historyPresetRange(today, next);
    setFrom(dates.from);
    setTo(dates.to);
  }

  const displayZone = analytics?.range.timeZone || timeZone || "Asia/Shanghai";
  const periodDays = analytics?.range.days ?? (spanDays || 7);
  const isCustom = preset === "custom";
  const isCalendarRange = isCustom || preset === "lastMonth";
  useEffect(() => {
    if (isCustom) fromInputRef.current?.focus();
  }, [isCustom]);
  const periodDelta = analytics
    ? deltaIndicator(analytics.period.revenueTotal, analytics.period.previousRevenueTotal)
    : null;
  const medianDuration = analytics
    ? formatDurationSummary(analytics.period.medianDurationMinutes)
    : null;
  const avgDuration = analytics
    ? formatDurationSummary(analytics.period.avgDurationMinutes)
    : null;
  const totalStayMinutes = analytics
    ? analytics.period.totalEffectiveDurationMinutes + analytics.period.totalInactiveDurationMinutes
    : 0;
  const inactiveShare =
    totalStayMinutes > 0 && analytics && analytics.period.totalInactiveDurationMinutes > 0
      ? Math.round((analytics.period.totalInactiveDurationMinutes / totalStayMinutes) * 100)
      : 0;
  const peak = traffic
    ? peakHourSummary(
        traffic.presence.totals.some((value) => value > 0)
          ? traffic.presence.averages
          : traffic.entries.averages,
      )
    : analytics
      ? peakHourSummary(analytics.hourlyVisits)
      : null;

  async function exportSelected() {
    if (!analytics || !traffic || exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const { loadExportCheckouts, createHistoryWorkbook, downloadHistoryWorkbook } = await import("./history-export");
      const records = await loadExportCheckouts(request, recordsRange, archive);
      const bytes = await createHistoryWorkbook({ analytics, traffic, records, archive, excludeStaff: true,
        excludedPlayers: excludedIds,
        deviceNames: new Map((devices ?? []).map(device => [device.id, device.name])) });
      downloadHistoryWorkbook(bytes, `PRiSM-${shopCode}-${from}-${to}-${archive}.xlsx`);
    } catch (error) {
      setExportError(errorText(error));
    } finally {
      setExporting(false);
    }
  }

  async function refreshAll() {
    setRefreshing(true);
    setRefreshSignal((value) => value + 1);
    analyticsResource.reload();
    playerOptions.reload();
    await loadDevices();
    setRefreshing(false);
  }

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-xl font-semibold">{t("历史")}</h2>
          <span className="text-xs text-ink/50 tabular-nums">
            {valid
              ? `${from} – ${to} · ${t("{days} 天", { days: spanDays })}`
              : t("请选择有效日期")}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {view === "overview" && (
            <button type="button" className={button} disabled={exporting || !analytics || !traffic}
              onClick={() => void exportSelected()}>
              <Download size={15} aria-hidden="true" />
              {t(exporting ? "正在导出..." : "导出 Excel")}
            </button>
          )}
          <button
            type="button"
            className={button}
            aria-label={t("刷新")}
            disabled={refreshing}
            onClick={() => void refreshAll()}
          >
            <RefreshCw
              size={15}
              className={refreshing ? "animate-spin" : ""}
              aria-hidden="true"
            />
            {t("刷新")}
          </button>
        </div>
      </header>
      <div
        role="group"
        aria-label={t("历史视图")}
        className="inline-flex w-fit flex-wrap rounded-xl bg-ink/[0.045] p-0.5 text-xs"
      >
        {(
          [
            ["overview", "经营与结账"],
            ["operations", "全店操作记录"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={`focus-ring rounded-[10px] px-3 py-1.5 font-medium transition-colors ${
              view === key
                ? "bg-primary text-primary-foreground"
                : "text-ink/65 hover:text-ink"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {exportError && <p role="alert" className="text-sm text-coral">{exportError}</p>}

      {view === "operations" ? (
        <section
          className="grid gap-4 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
          aria-label={t("全店操作记录")}
        >
          <h3 className="text-base font-semibold">{t("全店操作记录")}</h3>
          <ShopOperationHistory
            shopId={shopId}
            shopCode={shopCode}
            devices={devices ?? []}
            refreshSignal={refreshSignal}
          />
        </section>
      ) : (
        <>
      {/* Unified Time Range Selector driving both historical analytics charts and checkout records */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 bg-panel p-3 shadow-soft">
        <div
          role="group"
          aria-label={t("统计周期")}
          className="inline-flex flex-wrap rounded-xl bg-ink/[0.045] p-0.5 text-xs"
        >
          {(
            [
              [7, "近 {days} 天"],
              [14, "近 {days} 天"],
              [30, "近 {days} 天"],
              ["lastMonth", "上个月"],
              ["custom", "自定义"],
            ] as const
          ).map(([option, label]) => (
            <button
              key={String(option)}
              type="button"
              aria-pressed={preset === option}
              onClick={() => selectPreset(option)}
              className={`focus-ring rounded-[10px] px-3 py-1.5 font-medium transition-colors ${
                preset === option
                  ? "bg-primary text-primary-foreground"
                  : "text-ink/65 hover:text-ink"
              }`}
            >
              {typeof option === "string" ? t(label) : t(label, { days: option })}
            </button>
          ))}
        </div>

        {isCustom && <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5">
            <span className="text-ink/60">{t("从")}</span>
            <input
              ref={fromInputRef}
              type="date"
              required
              aria-label={t("从")}
              value={from}
              max={to}
              onChange={(e) => {
                setPreset("custom");
                setFrom(e.target.value);
                setOffset(0);
              }}
              className={`focus-ring min-h-9 rounded-lg border bg-canvas px-2.5 py-1 text-sm text-ink dark:bg-surface ${
                isCustom ? "border-mint/60" : "border-ink/15"
              }`}
            />
          </label>
          <span className="text-ink/40" aria-hidden="true">–</span>
          <label className="inline-flex items-center gap-1.5">
            <span className="text-ink/60">{t("至")}</span>
            <input
              type="date"
              required
              aria-label={t("至")}
              value={to}
              min={from}
              onChange={(e) => {
                setPreset("custom");
                setTo(e.target.value);
                setOffset(0);
              }}
              className={`focus-ring min-h-9 rounded-lg border bg-canvas px-2.5 py-1 text-sm text-ink dark:bg-surface ${
                isCustom ? "border-mint/60" : "border-ink/15"
              }`}
            />
          </label>
        </div>}
      </div>

      {!valid ? (
        <State error={t("请选择有效日期")} />
      ) : !playerOptions.data ? (
        <State error={playerOptions.error ? errorText(playerOptions.error) : undefined} />
      ) : (
        <>
          {/* Historical period summary KPI strip. */}
          <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
            <div className="grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 shadow-soft">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink/60">
                  {isCalendarRange ? t("所选时段营收") : t("近 {days} 天营收", { days: periodDays })}
                </span>
                <span className="grid size-7 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <Wallet size={15} aria-hidden="true" />
                </span>
              </div>
              <div className="flex flex-wrap items-baseline gap-2 tabular-nums">
                <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {analytics ? `¥${money(analytics.period.revenueTotal)}` : "—"}
                </strong>
                {periodDelta && <DeltaBadge delta={periodDelta} label={t("较上期")} />}
              </div>
              <p className="truncate text-xs text-ink/55 tabular-nums">
                {analytics
                  ? `${t("中位")} ¥${money(analytics.period.medianTicket)} · ${t("均单")} ¥${money(analytics.period.avgTicket)} · ${analytics.period.checkoutCount} ${t("笔")}`
                  : "—"}
              </p>
            </div>

            <div className="grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 shadow-soft">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink/60">
                  {isCalendarRange ? t("所选时段客流") : t("近 {days} 天客流", { days: periodDays })}
                </span>
                <span className="grid size-7 place-items-center rounded-full bg-mint/10 text-mint">
                  <Users size={15} aria-hidden="true" />
                </span>
              </div>
              <div className="flex items-baseline gap-1.5 tabular-nums">
                <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {analytics ? analytics.period.visitCount : "—"}
                </strong>
                <span className="text-xs text-ink/55">{t("人次")}</span>
              </div>
              <p className="truncate text-xs text-ink/55 tabular-nums">
                {analytics
                  ? `${t("活跃玩家")} ${analytics.period.uniquePlayerCount} · ${t("新注册玩家")} ${analytics.period.newPlayerCount}`
                  : "—"}
              </p>
            </div>

            <div className="grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 shadow-soft">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink/60">{t("中位有效在店时长")}</span>
                <span className="grid size-7 place-items-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">
                  <Clock size={15} aria-hidden="true" />
                </span>
              </div>
              <div className="flex items-baseline gap-1.5 tabular-nums">
                <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {analytics
                    ? medianDuration
                      ? medianDuration.hours
                        ? t("{hours} 时 {minutes} 分", medianDuration)
                        : t("{minutes} 分", medianDuration)
                      : "—"
                    : "—"}
                </strong>
              </div>
              <p
                className="truncate text-xs text-ink/55 tabular-nums"
                title={
                  analytics
                    ? t(
                        "有效 {effective} 分钟 · 无效 {inactive} 分钟（涉及 {checkouts} 笔结账，超过单次时长上限的部分）",
                        {
                          effective: analytics.period.totalEffectiveDurationMinutes,
                          inactive: analytics.period.totalInactiveDurationMinutes,
                          checkouts: analytics.period.inactiveCheckoutCount,
                        },
                      )
                    : undefined
                }
              >
                {analytics
                  ? avgDuration
                    ? `${t("均值")} ${
                        avgDuration.hours
                          ? t("{hours} 时 {minutes} 分", avgDuration)
                          : t("{minutes} 分", avgDuration)
                      }${inactiveShare > 0 ? ` · ${t("无效占比")} ${inactiveShare}%` : ""}`
                    : `${t("资产入账")} ${analytics.period.assetGrantCount} ${t("笔")}`
                  : "—"}
              </p>
            </div>

            <div className="grid content-between gap-2.5 rounded-2xl border border-ink/10 bg-panel p-4 shadow-soft">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-ink/60">
                  {isCalendarRange ? t("所选时段投币") : t("近 {days} 天投币", { days: periodDays })}
                </span>
                <span className="grid size-7 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Coins size={15} aria-hidden="true" />
                </span>
              </div>
              <div className="flex items-baseline gap-1.5 tabular-nums">
                <strong className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {analytics ? analytics.period.coinCount : "—"}
                </strong>
                <span className="text-xs text-ink/55">{t("币")}</span>
              </div>
              <p className="truncate text-xs text-ink/55 tabular-nums">
                {analytics
                  ? peak
                    ? `${t("高峰时段")} ${peak.label}`
                    : t("暂无高峰数据")
                  : "—"}
              </p>
            </div>
          </div>

          {/* Historical Analytics Charts */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <RevenueTrendChart
              analytics={analytics}
              days={periodDays}
              custom={isCalendarRange}
              loading={analyticsLoading}
              error={analyticsError}
            />
            <PaymentBreakdownCard
              analytics={analytics}
              loading={analyticsLoading}
              error={analyticsError}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <HourlyTrafficChart
              series={traffic?.entries ?? null}
              title="时段入场分布"
              timeZone={displayZone}
              loading={analyticsLoading}
              error={analyticsError}
            />
            <HourlyTrafficChart
              series={traffic?.presence ?? null}
              title="时段在场分布"
              timeZone={displayZone}
              loading={analyticsLoading}
              error={analyticsError}
            />
            <div className="lg:col-span-2">
            <TopDevicesCard
              topDevicesByHeat={analytics?.topDevicesByHeat ?? []}
              devices={devices}
              shopCode={shopCode}
              loading={analyticsLoading}
              error={analyticsError}
            />
            </div>
          </div>

          {/* Detailed Checkout Records sharing the same unified date range */}
          <section
            className="grid gap-4 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
            aria-label={t("结账记录")}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h3 className="text-base font-semibold">{t("结账记录")}</h3>
                <span className="text-xs text-ink/50 tabular-nums">
                  {from} – {to}
                </span>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="whitespace-nowrap text-xs font-medium text-ink/60">
                  {t("归档筛选")}
                </span>
                <select
                  aria-label={t("归档筛选")}
                  className="focus-ring min-h-10 rounded-lg border border-ink/15 bg-panel px-3 py-1.5 text-sm font-normal"
                  value={archive}
                  onChange={(e) => {
                    setArchive(e.target.value as ReportArchiveFilter);
                    setOffset(0);
                  }}
                >
                  <option value="active">{t("默认")}</option>
                  <option value="all">{t("全部")}</option>
                  <option value="archived">{t("已归档")}</option>
                </select>
              </label>
            </div>
            <ReportResults
              key={`${recordsRange}:${archive}:${offset}`}
              range={recordsRange}
              archive={archive}
              offset={offset}
              setOffset={setOffset}
              refreshSignal={refreshSignal}
              onMutated={analyticsResource.reload}
            />
          </section>
        </>
      )}
        </>
      )}
    </div>
  );
}

function ReportResults({
  range,
  archive,
  offset,
  setOffset,
  refreshSignal,
  onMutated,
}: {
  range: string;
  archive: ReportArchiveFilter;
  offset: number;
  setOffset: (offset: number) => void;
  refreshSignal: number;
  onMutated?: () => void;
}) {
  const { t, errorText } = useI18n();
  const { timeZone } = useMerchant();
  const [selected, setSelected] = useState<string | null>(null);
  const checkouts = useResource<{
    records: StaffReportCheckout[];
    page: { hasMore: boolean };
  }>(`reports/checkouts?${range}&archive=${archive}&limit=50&offset=${offset}`);

  const handledRefresh = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === handledRefresh.current) return;
    handledRefresh.current = refreshSignal;
    checkouts.reload();
  }, [refreshSignal, checkouts.reload]);

  function changed() {
    setSelected(null);
    checkouts.reload();
    onMutated?.();
    if (offset && archive !== "all" && checkouts.data?.records.length === 1)
      setOffset(Math.max(0, offset - 50));
  }
  const actionBtn = `${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-sm`;
  const open = (record: StaffReportCheckout) => (
    <button className={actionBtn} onClick={() => setSelected(record.checkoutId)}>
      {t("账单详情")}
    </button>
  );
  return (
    <>
      {checkouts.error ? (
        <State error={errorText(checkouts.error)} />
      ) : !checkouts.data ? (
        <State />
      ) : !checkouts.data.records.length ? (
        <State empty />
      ) : (
        <>
          <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden md:hidden">
            {checkouts.data.records.map((record) => (
              <div
                key={record.checkoutId}
                className="grid gap-2 px-4 py-3.5"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <strong className="truncate text-[15px]">
                      {record.playerDisplayName}
                    </strong>
                    {record.archived && (
                      <span className="shrink-0 rounded-full bg-ink/5 px-2 py-0.5 text-xs font-medium text-ink/55">
                        {t("已归档")}
                      </span>
                    )}
                  </div>
                  <strong className="shrink-0 text-[15px] tabular-nums">
                    {money(record.total)}
                  </strong>
                </div>
                <span className="text-xs text-ink/60 tabular-nums">
                  {displayDateTime(record.settledAt, timeZone)} ·{" "}
                  {payment(record, t)} · {record.sessionCount} {t("项计时")} ·{" "}
                  {record.durationMinutes} {t("分钟")}
                </span>
                <div className="flex flex-wrap justify-end gap-2 pt-1">
                  {open(record)}
                  <ReportArchiveAction record={record} changed={changed} />
                </div>
              </div>
            ))}
          </div>
          <div className="hidden md:block">
            <Table
              headers={[
                "玩家",
                "结账时间",
                "累计时长",
                "金额",
                "收款方式",
                "操作",
              ]}
            >
              {checkouts.data.records.map((record) => (
                <tr key={record.checkoutId}>
                  <td className={cell}>
                    <strong>{record.playerDisplayName}</strong>
                    <p className="text-xs text-ink/60">
                      {record.sessionCount} {t("项计时")}
                    </p>
                  </td>
                  <td className={`${cell} whitespace-nowrap`}>
                    {displayDateTime(record.settledAt, timeZone)}
                  </td>
                  <td className={cell}>{record.durationMinutes} {t("分钟")}</td>
                  <td className={cell}>{money(record.total)}</td>
                  <td className={cell}>{payment(record, t)}</td>
                  <td className={cell}>
                    <div className="flex flex-wrap gap-2">
                      {open(record)}
                      <ReportArchiveAction record={record} changed={changed} />
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          </div>
        </>
      )}
      {checkouts.data && (
        <div className="flex justify-end gap-2">
          <button
            className={button}
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            {t("上一页")}
          </button>
          <button
            className={button}
            disabled={!checkouts.data.page.hasMore}
            onClick={() => setOffset(offset + 50)}
          >
            {t("下一页")}
          </button>
        </div>
      )}
      {checkouts.error && (
        <button
          className={`${button} justify-self-start`}
          onClick={() => {
            checkouts.reload();
          }}
        >
          {t("重试")}
        </button>
      )}
      {selected && (
        <ReportDetail
          key={selected}
          checkoutId={selected}
          close={() => setSelected(null)}
          changed={changed}
        />
      )}
    </>
  );
}

function ReportArchiveAction({
  record,
  changed,
}: {
  record: StaffReportCheckout;
  changed: () => void;
}) {
  const { t, errorText } = useI18n();
  const { canWrite, shopCode } = useMerchant();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    locked.current = false;
    setBusy(false);
  }, [record]);
  async function change() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await setReportArchive(shopCode, record.checkoutId, !record.archived);
      changed();
    } catch (e) {
      locked.current = false;
      setBusy(false);
      setError(errorText(e instanceof Error ? e.message : "操作失败"));
    }
  }
  if (!canWrite) return null;
  return (
    <div className="grid gap-1">
      <button
        className={`${button} !min-h-9 !rounded-xl !px-3.5 !py-1.5 !text-sm`}
        disabled={busy}
        onClick={() => void change()}
        title={t(
          record.archived
            ? "恢复此账单后，营业额将增加 {amount}。"
            : "归档此账单后，营业额将减少 {amount}。",
          { amount: money(record.total) },
        )}
      >
        {t(busy ? "处理中…" : record.archived ? "恢复账单" : "归档账单")}
      </button>
      {error && (
        <p className="text-xs text-coral" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ReportDetail({
  checkoutId,
  close,
  changed,
}: {
  checkoutId: string;
  close: () => void;
  changed: () => void;
}) {
  const { t, errorText } = useI18n();
  const { timeZone, canWrite, shopCode } = useMerchant();
  const detail = useResource<StaffReportCheckoutDetail>(
    `reports/checkouts/${segment(checkoutId)}`,
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const at = (value: string | null | undefined) =>
    value ? displayDateTime(value, timeZone) : "—";
  async function changeArchive() {
    if (busy || !detail.data) return;
    setBusy(true);
    setError("");
    try {
      await setReportArchive(
        shopCode,
        checkoutId,
        !detail.data.record.archived,
      );
      changed();
    } catch (e) {
      setError(errorText(e instanceof Error ? e.message : "操作失败"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="账单详情" close={close} dismissDisabled={busy}>
      {detail.error ? (
        <State error={errorText(detail.error)} />
      ) : !detail.data ? (
        <State />
      ) : (
        (() => {
          const { record, receipt } = detail.data;
          const bill = {
            ...receipt,
            settlementPreview: receipt.playerSettlement,
          };
          const details: [string, string][] = [
            ["入场时间", at(record.startedAt)],
            ["结束时间", at(record.endedAt)],
            ...(record.externalPayment
              ? [
                  ["收款员工", record.externalPayment.staffId] as [string, string],
                  ["收款时间", at(record.externalPayment.collectedAt)] as [string, string],
                ]
              : []),
            ...(record.updatedAt
              ? [
                  ["最近归档操作时间", at(record.updatedAt)] as [string, string],
                  ["操作员工", record.updatedBy ?? "—"] as [string, string],
                ]
              : []),
          ];
          return (
            <div className="grid gap-5">
              {/* Compact Receipt Header */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-lg font-semibold text-ink">
                    {record.playerDisplayName}
                  </strong>
                  {record.archived && (
                    <span className="inline-flex items-center rounded-full bg-ink/5 px-2.5 py-0.5 text-xs font-medium text-ink/55">
                      {t("已归档")}
                    </span>
                  )}
                </div>
                <span className="rounded-full bg-ink/[0.045] px-2.5 py-0.5 text-xs font-medium text-ink/65">
                  {payment(record, t)}
                </span>
              </div>

              {/* Bento Summary Card */}
              <div className="bill-entry !mb-0 p-4">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-ink/55">{t("计费小计")}</dt>
                    <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-ink">
                      {money(record.subtotal)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink/55">{t("结账后余额")}</dt>
                    <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-ink">
                      {receipt.wallet ? money(receipt.wallet.balanceAfter) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink/55">{t("累计时长")}</dt>
                    <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-ink">
                      {record.durationMinutes} {t("分钟")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink/55">{t("结账时间")}</dt>
                    <dd className="mt-1 text-sm font-medium tabular-nums text-ink">
                      {at(record.settledAt)}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Pattern A Inset Metadata Rows */}
              <div className="bill-entry !mb-0 !p-0 divide-y divide-ink/[0.06] overflow-hidden text-sm">
                {details.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3.5 py-2.5"
                  >
                    <span className="shrink-0 text-ink/55">{t(label)}</span>
                    <span className="min-w-0 break-all text-right font-medium text-ink tabular-nums">
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <BillTotal preview={bill} />
              <h3 className="font-semibold">{t("完整时间轴")}</h3>
              <BillTimeline preview={bill} timeZone={timeZone} />
              <details className="bill-entry !mb-0 p-4">
                <summary className="cursor-pointer font-medium">
                  {t("计时与收费明细")}
                </summary>
                <div className="mt-3 divide-y divide-ink/[0.06] rounded-xl bg-panel/75 text-sm">
                  {(receipt.settlements ?? []).map(({ settlement }, index, list) => {
                    const trackNames = [
                      ...new Set(
                        (receipt.timeline?.tracks ?? [])
                          .filter(
                            (track) =>
                              track.id === settlement.sessionId ||
                              track.id.startsWith(`${settlement.sessionId}:`),
                          )
                          .map((track) => track.name)
                          .filter(Boolean),
                      ),
                    ];
                    const sessionLabel = trackNames.length
                      ? trackNames.join(" + ")
                      : list.length > 1
                        ? `${t("计时")} #${index + 1}`
                        : t("计时");
                    return (
                      <div
                        key={settlement.sessionId}
                        className="flex flex-wrap items-baseline justify-between gap-2 px-3.5 py-2.5 break-words"
                      >
                        <span className="font-medium text-ink">{sessionLabel}</span>
                        <span className="text-xs text-ink/60 tabular-nums">
                          {at(settlement.startedAt)} – {at(settlement.endedAt)}
                        </span>
                      </div>
                    );
                  })}
                  {[...receipt.chargeItems, ...receipt.adjustments].map(
                    (item, i) => (
                      <div
                        key={i}
                        className="flex items-baseline justify-between gap-4 px-3.5 py-2.5"
                      >
                        <span className="text-ink/80">{item.label}</span>
                        <span className="font-medium tabular-nums text-ink">
                          {money(item.amount)}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </details>
              <p className="text-sm text-ink/60">
                {t(
                  "归档会隐藏账单并从营业额中排除；玩家记录、余额和其他统计不变。恢复后重新计入营业额。",
                )}
              </p>
              {canWrite &&
                (!confirming ? (
                  <button
                    className={`${button} justify-self-start`}
                    onClick={() => setConfirming(true)}
                  >
                    {t(record.archived ? "恢复账单" : "归档账单")}
                  </button>
                ) : (
                  <div className="grid gap-3 rounded-xl border border-ink/20 p-4">
                    <p className="text-sm">
                      {t(
                        record.archived
                          ? "恢复此账单后，营业额将增加 {amount}。"
                          : "归档此账单后，营业额将减少 {amount}。",
                        { amount: money(record.total) },
                      )}
                    </p>
                    {error && (
                      <p role="alert" className="text-sm text-coral">
                        {error}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={primary}
                        disabled={busy}
                        onClick={() => void changeArchive()}
                      >
                        {t(
                          busy
                            ? "处理中…"
                            : record.archived
                              ? "确认恢复"
                              : "确认归档",
                        )}
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => setConfirming(false)}
                      >
                        {t("取消")}
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          );
        })()
      )}
    </Modal>
  );
}
