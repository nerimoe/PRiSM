import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  CreditCard,
  Gamepad2,
} from "lucide-react";
import type { Resource } from "../../api";
import { useI18n } from "../../i18n";
import {
  formatDurationSummary,
  paymentShares,
  peakHourSummary,
  type DashboardAnalytics,
  type DashboardAnalyticsDeviceActivity,
  type DashboardAnalyticsPaymentMethod,
} from "./dashboard-metrics";
import { money, segment } from "./shared";

type TrendMetric = "revenue" | "visits" | "coins";

export function DeltaBadge({
  delta,
  label,
}: {
  delta: { direction: "up" | "down" | "flat"; percent: number | null; text: string };
  label: string;
}) {
  const { t } = useI18n();
  if (delta.direction === "flat") {
    return (
      <span className="text-[11px] font-medium text-ink/45">
        {delta.text} {label}
      </span>
    );
  }
  const positive = delta.direction === "up";
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
        positive
          ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
          : "bg-coral/12 text-coral"
      }`}
    >
      {positive ? (
        <ArrowUpRight size={12} aria-hidden="true" />
      ) : (
        <ArrowDownRight size={12} aria-hidden="true" />
      )}
      {delta.text ? `${delta.text} ${label}` : `${t("新增")} · ${label}`}
    </span>
  );
}

const PAYMENT_LABELS: Record<DashboardAnalyticsPaymentMethod["method"], string> = {
  balance: "资产结算",
  wechat: "微信",
  alipay: "支付宝",
  cash: "现金",
  other: "其他",
};

const PAYMENT_BAR_COLORS: Record<DashboardAnalyticsPaymentMethod["method"], string> = {
  balance: "bg-mint",
  wechat: "bg-emerald-500",
  alipay: "bg-sky-500",
  cash: "bg-amber-500",
  other: "bg-ink/35",
};

function formatAxisNumber(value: number, currency: boolean): string {
  if (currency) {
    if (value >= 10000) return `¥${(value / 1000).toFixed(1)}k`;
    if (value >= 1000) return `¥${Math.round(value)}`;
    return `¥${value % 1 === 0 ? value : value.toFixed(0)}`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function RevenueTrendChart({
  analytics,
  days,
  custom = false,
  loading,
  error,
}: {
  analytics: DashboardAnalytics | null;
  days: number;
  custom?: boolean;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<TrendMetric>("revenue");
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const gradId = useId();
  const daily = analytics?.daily ?? [];

  const values = useMemo(
    () =>
      daily.map((point) =>
        metric === "revenue" ? point.revenue : metric === "visits" ? point.visits : point.coins,
      ),
    [daily, metric],
  );
  const maxVal = Math.max(1, ...values);
  const maxVisits = Math.max(0, ...daily.map((point) => point.visits));
  const hasAnyData = values.some((v) => v > 0) || (metric === "revenue" && maxVisits > 0);
  const hovered = hoveredIndex !== null ? daily[hoveredIndex] ?? null : null;

  const width = 640;
  const height = 210;
  const padLeft = 48;
  const padRight = 14;
  const padTop = 16;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const slotW = daily.length ? plotW / daily.length : plotW;
  const barW = Math.max(1.5, Math.min(28, slotW * 0.62));
  const labelStride =
    daily.length <= 7 ? 1 : daily.length <= 14 ? 2 : Math.ceil(daily.length / 6);

  const visitLinePoints = useMemo(() => {
    if (metric !== "revenue" || maxVisits <= 0 || daily.length < 2) return "";
    return daily
      .map((point, index) => {
        const x = padLeft + index * slotW + slotW / 2;
        const y = padTop + plotH - (point.visits / maxVisits) * (plotH * 0.86);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [daily, maxVisits, metric, padLeft, padTop, plotH, slotW]);

  return (
    <section
      className="grid min-w-0 content-start gap-4 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
      aria-label={t("营收与客流趋势")}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 size={18} className="text-mint" aria-hidden="true" />
          <h3 className="text-base font-semibold">{t("营收与客流趋势")}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={t("趋势指标")}
            className="inline-flex rounded-xl bg-ink/[0.05] p-0.5 text-xs"
          >
            {(
              [
                ["revenue", "营收"],
                ["visits", "客流"],
                ["coins", "投币"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
                className={`focus-ring rounded-[10px] px-2.5 py-1.5 font-medium transition-colors ${
                  metric === key
                    ? "bg-panel text-ink shadow-sm"
                    : "text-ink/60 hover:text-ink"
                }`}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink/[0.03] px-3 py-2 text-xs tabular-nums">
        {hovered ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink">
            <strong className="font-semibold">{hovered.date}</strong>
            <span>
              {t("营收")} ¥{money(hovered.revenue)}
            </span>
            <span className="text-ink/70">
              {hovered.checkouts} {t("笔")}
            </span>
            <span className="text-ink/70">
              {hovered.visits} {t("人次")}
            </span>
            <span className="text-ink/70">
              {hovered.coins} {t("币")}
            </span>
          </div>
        ) : analytics ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink/75">
            <span className="font-medium text-ink">
              {custom ? t("所选时段合计") : t("近 {days} 天合计", { days })}
            </span>
            <span>
              {t("营收")} ¥{money(analytics.period.revenueTotal)}
            </span>
            <span>
              {analytics.period.visitCount} {t("人次")}
            </span>
            <span>
              {analytics.period.coinCount} {t("币")}
            </span>
          </div>
        ) : (
          <span className="text-ink/50">{t(loading ? "加载中..." : "暂无趋势数据")}</span>
        )}
        {metric === "revenue" && maxVisits > 0 && (
          <span className="flex items-center gap-3 text-[11px] text-ink/55">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block size-2 rounded-sm bg-mint" aria-hidden="true" />
              {t("营收")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3 rounded-full bg-emerald-500" aria-hidden="true" />
              {t("客流")}
            </span>
          </span>
        )}
      </div>

      {error ? (
        <p role="alert" className="py-10 text-center text-sm text-coral">
          {error}
        </p>
      ) : !daily.length ? (
        <div className="grid h-[210px] place-items-center text-sm text-ink/50">
          {t(loading ? "加载中..." : "暂无趋势数据")}
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-[210px] w-full overflow-visible"
            role="img"
            aria-label={t("营收与客流趋势")}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-mint)" stopOpacity="0.95" />
                <stop offset="100%" stopColor="var(--color-mint)" stopOpacity="0.45" />
              </linearGradient>
            </defs>

            {[0, 0.5, 1].map((ratio) => {
              const y = padTop + plotH * (1 - ratio);
              const tickValue = maxVal * ratio;
              return (
                <g key={ratio}>
                  <line
                    x1={padLeft}
                    y1={y}
                    x2={width - padRight}
                    y2={y}
                    stroke="currentColor"
                    strokeOpacity={ratio === 0 ? 0.14 : 0.08}
                    strokeDasharray={ratio === 0 ? undefined : "3 4"}
                  />
                  <text
                    x={padLeft - 8}
                    y={y + 3}
                    textAnchor="end"
                    fontSize="10"
                    fill="currentColor"
                    fillOpacity="0.48"
                  >
                    {formatAxisNumber(tickValue, metric === "revenue")}
                  </text>
                </g>
              );
            })}

            {daily.map((point, index) => {
              const value = values[index] ?? 0;
              const ratio = maxVal > 0 ? value / maxVal : 0;
              const barHeight = value > 0 ? Math.max(4, ratio * plotH) : 2;
              const x = padLeft + index * slotW + (slotW - barW) / 2;
              const y = padTop + plotH - barHeight;
              const active = hoveredIndex === index;
              const showXLabel =
                index % labelStride === 0 ||
                (index === daily.length - 1 &&
                  index % labelStride >= Math.ceil(labelStride * 0.5));
              return (
                <g key={point.date}>
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={barHeight}
                    rx={value > 0 ? Math.min(6, barW / 3) : 1}
                    fill={value > 0 ? `url(#${gradId})` : "currentColor"}
                    fillOpacity={value > 0 ? (active ? 1 : hoveredIndex === null ? 0.85 : 0.52) : 0.14}
                    className="transition-opacity duration-150"
                  />
                  {showXLabel && (
                    <text
                      x={padLeft + index * slotW + slotW / 2}
                      y={height - 8}
                      textAnchor="middle"
                      fontSize="10"
                      fill="currentColor"
                      fillOpacity={active ? 0.9 : 0.5}
                      fontWeight={active ? 600 : 400}
                    >
                      {point.date.slice(5)}
                    </text>
                  )}
                </g>
              );
            })}

            {visitLinePoints && (
              <>
                <polyline
                  fill="none"
                  stroke="#10b981"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={visitLinePoints}
                />
                {daily.map((point, index) => {
                  const active = hoveredIndex === index;
                  if (daily.length > 31 && !active) return null;
                  const x = padLeft + index * slotW + slotW / 2;
                  const y = padTop + plotH - (point.visits / maxVisits) * (plotH * 0.86);
                  return (
                    <circle
                      key={`v-${point.date}`}
                      cx={x}
                      cy={y}
                      r={active ? 4.2 : 2.6}
                      fill="#10b981"
                      stroke="var(--color-panel)"
                      strokeWidth="1.5"
                    />
                  );
                })}
              </>
            )}

            {/* Hit areas last so hover & keyboard focus stay smooth across bars and lines. */}
            {daily.map((point, index) => (
              <rect
                key={`hit-${point.date}`}
                x={padLeft + index * slotW}
                y={padTop}
                width={slotW}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${point.date} · ${t("营收")} ¥${money(point.revenue)} · ${point.visits} ${t("人次")}`}
                className="cursor-pointer outline-none"
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex((cur) => (cur === index ? null : cur))}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex((cur) => (cur === index ? null : cur))}
              />
            ))}
          </svg>
          {!hasAnyData && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-4 text-center text-xs text-ink/45">
              {t("所选时段暂无营收或客流记录")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export function HourlyTrafficChart({
  hourlyVisits,
  title = "时段入场分布",
  timeZone,
  loading,
  error,
}: {
  hourlyVisits: readonly number[];
  title?: "时段入场分布" | "时段在场分布";
  timeZone: string;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);
  const hours = hourlyVisits.length === 24 ? hourlyVisits : Array.from({ length: 24 }, () => 0);
  const peak = peakHourSummary(hours);
  const max = Math.max(1, ...hours);

  const width = 420;
  const height = 148;
  const padX = 8;
  const padTop = 12;
  const padBottom = 24;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;
  const slotW = plotW / 24;
  const barW = slotW * 0.66;

  return (
    <section
      className="grid min-w-0 content-start gap-3 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
      aria-label={t(title)}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock size={17} className="text-mint" aria-hidden="true" />
          <h3 className="text-base font-semibold">{t(title)}</h3>
        </div>
        {peak ? (
          <span className="rounded-full bg-mint/10 px-2.5 py-0.5 text-xs font-medium text-mint tabular-nums">
            {t("高峰")} {peak.label}
          </span>
        ) : null}
      </header>

      <p className="text-xs text-ink/60">{t(title === "时段在场分布"
        ? "各时段内有计时在场的玩家，按玩家和自然日去重；跨小时计入各时段。"
        : "各时段内开始计时的玩家，按玩家和自然日去重。")}</p>
      <p className="text-xs text-ink/60 tabular-nums">
        {hoveredHour !== null
          ? `${String(hoveredHour).padStart(2, "0")}:00–${String(hoveredHour).padStart(2, "0")}:59 · ${hours[hoveredHour] ?? 0} ${t("人次")}`
          : peak
            ? `${t("高峰时段 {count} 人次", { count: peak.count })} · ${timeZone || "Asia/Shanghai"}`
            : t(loading ? "加载中..." : "暂无时段客流数据")}
      </p>

      {error ? (
        <p role="alert" className="py-8 text-center text-sm text-coral">
          {error}
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[148px] w-full"
          role="img"
          aria-label={t(title)}
        >
          <line
            x1={padX}
            y1={padTop + plotH}
            x2={width - padX}
            y2={padTop + plotH}
            stroke="currentColor"
            strokeOpacity="0.14"
          />
          {hours.map((count, hour) => {
            const barH = count > 0 ? Math.max(4, (count / max) * plotH) : 2;
            const x = padX + hour * slotW + (slotW - barW) / 2;
            const y = padTop + plotH - barH;
            const isPeak = peak !== null && count === peak.count && count > 0;
            const isHovered = hoveredHour === hour;
            const showLabel = hour === 0 || hour === 6 || hour === 12 || hour === 18 || hour === 23;
            return (
              <g key={hour}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={barH}
                  rx={3}
                  fill={isPeak || isHovered ? "var(--color-mint)" : "currentColor"}
                  fillOpacity={
                    count === 0
                      ? 0.14
                      : isPeak || isHovered
                        ? 0.95
                        : count >= max * 0.65
                          ? 0.45
                          : 0.25
                  }
                />
                {showLabel && (
                  <text
                    x={padX + hour * slotW + slotW / 2}
                    y={height - 6}
                    textAnchor="middle"
                    fontSize="10"
                    fill="currentColor"
                    fillOpacity="0.48"
                  >
                    {String(hour).padStart(2, "0")}
                  </text>
                )}
                <rect
                  x={padX + hour * slotW}
                  y={padTop}
                  width={slotW}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={`${String(hour).padStart(2, "0")}:00 · ${count} ${t("人次")}`}
                  className="cursor-pointer outline-none"
                  onMouseEnter={() => setHoveredHour(hour)}
                  onMouseLeave={() => setHoveredHour((cur) => (cur === hour ? null : cur))}
                  onFocus={() => setHoveredHour(hour)}
                  onBlur={() => setHoveredHour((cur) => (cur === hour ? null : cur))}
                />
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}

export function PaymentBreakdownCard({
  analytics,
  loading,
  error,
}: {
  analytics: DashboardAnalytics | null;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();
  const shares = paymentShares(analytics?.paymentMethods ?? []);
  const avgDuration = analytics ? formatDurationSummary(analytics.period.avgDurationMinutes) : null;

  return (
    <section
      className="grid min-w-0 content-between gap-4 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
      aria-label={t("收款方式与经营指标")}
    >
      <div className="grid gap-3.5">
        <header className="flex items-center gap-2">
          <CreditCard size={17} className="text-mint" aria-hidden="true" />
          <h3 className="text-base font-semibold">{t("收款方式与经营指标")}</h3>
        </header>

        {error ? (
          <p role="alert" className="py-6 text-center text-sm text-coral">
            {error}
          </p>
        ) : shares.length ? (
          <>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-ink/[0.06]" role="img" aria-label={t("收款方式占比")}>
              {shares.map((item) => (
                <span
                  key={item.method}
                  className={`${PAYMENT_BAR_COLORS[item.method]} h-full first:rounded-l-full last:rounded-r-full`}
                  style={{ width: `${Math.max(item.percent, 2)}%` }}
                  title={`${t(PAYMENT_LABELS[item.method])} ${item.percent}%`}
                />
              ))}
            </div>
            <ul className="grid gap-2 text-sm tabular-nums">
              {shares.map((item) => (
                <li key={item.method} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`size-2.5 shrink-0 rounded-full ${PAYMENT_BAR_COLORS[item.method]}`} aria-hidden="true" />
                    <span className="truncate font-medium">{t(PAYMENT_LABELS[item.method])}</span>
                    <span className="text-xs text-ink/50">
                      {item.count} {t("笔")}
                    </span>
                  </span>
                  <span className="shrink-0 font-medium">
                    ¥{money(item.revenue)}
                    <span className="ml-1.5 text-xs font-normal text-ink/50">{item.percent}%</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="py-4 text-center text-sm text-ink/50">
            {t(loading ? "加载中..." : "所选时段暂无结账记录")}
          </p>
        )}
      </div>

      {analytics && (
        <div className="grid grid-cols-2 gap-3 border-t border-ink/10 pt-3.5 text-xs">
          <div>
            <span className="block text-ink/55">{t("活跃玩家")}</span>
            <strong className="mt-1 block text-base font-semibold tabular-nums">
              {analytics.period.uniquePlayerCount}
            </strong>
          </div>
          <div>
            <span className="block text-ink/55">{t("新注册玩家")}</span>
            <strong className="mt-1 block text-base font-semibold tabular-nums">
              {analytics.period.newPlayerCount}
              {analytics.today.newPlayerCount > 0 && (
                <span className="ml-1.5 text-xs font-normal text-mint">
                  +{analytics.today.newPlayerCount} {t("今日")}
                </span>
              )}
            </strong>
          </div>
          <div>
            <span className="block text-ink/55">{t("平均在店时长")}</span>
            <strong className="mt-1 block text-base font-semibold tabular-nums">
              {avgDuration
                ? avgDuration.hours
                  ? t("{hours} 时 {minutes} 分", avgDuration)
                  : t("{minutes} 分", avgDuration)
                : "—"}
            </strong>
          </div>
          <div>
            <span className="block text-ink/55">{t("资产入账")}</span>
            <strong className="mt-1 block text-base font-semibold tabular-nums">
              {analytics.period.assetGrantCount}
            </strong>
          </div>
        </div>
      )}
    </section>
  );
}

export function TopDevicesCard({
  topDevices,
  devices,
  shopCode,
  loading,
  error,
}: {
  topDevices: readonly DashboardAnalyticsDeviceActivity[];
  devices: readonly Resource[] | null;
  shopCode: string;
  loading: boolean;
  error: string;
}) {
  const { t } = useI18n();
  const deviceNameById = useMemo(
    () => new Map((devices ?? []).map((device) => [device.id, device.name])),
    [devices],
  );
  const maxOps = Math.max(1, ...topDevices.map((item) => item.operations));

  return (
    <section
      className="grid min-w-0 content-start gap-3.5 rounded-2xl border border-ink/10 bg-panel p-5 shadow-soft"
      aria-label={t("热门资源活跃度")}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gamepad2 size={17} className="text-mint" aria-hidden="true" />
          <h3 className="text-base font-semibold">{t("热门资源活跃度")}</h3>
        </div>
        <Link
          to={`/merchant/${segment(shopCode)}/resources`}
          className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-mint hover:bg-mint/10"
        >
          <Activity size={13} aria-hidden="true" />
          {t("全部资源")}
        </Link>
      </header>

      {error ? (
        <p role="alert" className="py-6 text-center text-sm text-coral">
          {error}
        </p>
      ) : !topDevices.length ? (
        <p className="py-8 text-center text-sm text-ink/50">
          {t(loading ? "加载中..." : "所选时段暂无设备使用记录")}
        </p>
      ) : (
        <ol className="grid gap-3">
          {topDevices.map((item, index) => {
            const name = deviceNameById.get(item.deviceId) ?? item.deviceId;
            const widthPct = Math.max(8, Math.round((item.operations / maxOps) * 100));
            return (
              <li key={item.deviceId} className="grid gap-1.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink/[0.06] text-[11px] font-semibold text-ink/70 tabular-nums">
                      {index + 1}
                    </span>
                    <span className="truncate font-medium">{name}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {item.operations} <span className="text-xs font-normal text-ink/50">{t("次")}</span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
                  <div
                    className="h-full rounded-full bg-mint/80"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <p className="flex gap-3 text-xs text-ink/55 tabular-nums">
                  <span>
                    {item.swipes} {t("刷卡")}
                  </span>
                  <span>
                    {item.coins} {t("投币")}
                  </span>
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
