import type { StaffReportsAnalyticsSource } from "@prism/application";
import {
  addLocalDays,
  computeCheckoutDurationBreakdown,
  computeMedian,
  normalizeStayCapHours,
  rankReportDevices,
  formatLocalDate,
  formatOffsetTimestamp,
  parseReportTimestampMs,
  timestampDisplayParts,
} from "@prism/core";
import type {
  DashboardAnalytics,
  DashboardAnalyticsDailyPoint,
  DashboardAnalyticsPaymentMethod,
} from "./dashboard-metrics";

const addAmounts = (a: number, b: number) => a + b;

function parseStoredInstant(value: string): Date | null {
  const ms = parseReportTimestampMs(value);
  return ms === null ? null : new Date(ms);
}

function localPartsOf(raw: string, timeZone: string): { date: string; hour: number } | null {
  const parsed = parseStoredInstant(raw);
  if (!parsed) return null;
  const parts = timestampDisplayParts(formatOffsetTimestamp(parsed.toISOString(), timeZone));
  if (!parts) return null;
  const hour = Number(parts.time.slice(0, 2));
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? { date: parts.date, hour } : null;
}

const PAYMENT_METHOD_ORDER: readonly DashboardAnalyticsPaymentMethod["method"][] = [
  "balance",
  "wechat",
  "alipay",
  "cash",
  "other",
];

function normalizePaymentMethod(method: string | null): DashboardAnalyticsPaymentMethod["method"] {
  if (!method) return "balance";
  if (method === "wechat" || method === "alipay" || method === "cash" || method === "other") {
    return method;
  }
  return "other";
}

export function calculateHistoryAnalytics(facts: StaffReportsAnalyticsSource): DashboardAnalytics {
  const { checkoutRows, sessionRows, playerRows, operationRows } = facts;
  const { days, timeZone, startDate, endDate } = facts.range;
  const actualToday = formatLocalDate(new Date(facts.asOf), timeZone);
  const actualYesterday = addLocalDays(actualToday, -1);
  const prevStartDate = addLocalDays(startDate, -days);
  const daily: DashboardAnalyticsDailyPoint[] = [];
  const dailyMap = new Map<string, DashboardAnalyticsDailyPoint>();
  for (let i = 0; i < days; i += 1) {
    const date = addLocalDays(startDate, i);
    const point: DashboardAnalyticsDailyPoint = {
      date,
      revenue: 0,
      checkouts: 0,
      visits: 0,
      coins: 0,
    };
    daily.push(point);
    dailyMap.set(date, point);
  }

  const sessionsByCheckout = new Map<
    string,
    { startedAtMs: number; endedAtMs: number }[]
  >();
  for (const row of sessionRows) {
    if (!row.checkout_id || !row.ended_at) continue;
    const startedAtMs = parseReportTimestampMs(row.started_at);
    const endedAtMs = parseReportTimestampMs(row.ended_at);
    if (startedAtMs === null || endedAtMs === null) continue;
    const list = sessionsByCheckout.get(row.checkout_id) ?? [];
    list.push({
      startedAtMs,
      endedAtMs,
    });
    sessionsByCheckout.set(row.checkout_id, list);
  }

  let todayRevenueTotal = 0;
  let yesterdayRevenueTotal = 0;
  let todayCheckoutCount = 0;
  let yesterdayCheckoutCount = 0;
  const todayEffectiveDurations: number[] = [];

  let periodRevenueTotal = 0;
  let previousRevenueTotal = 0;
  let periodCheckoutCount = 0;
  let previousCheckoutCount = 0;
  const periodEffectiveDurations: number[] = [];
  const periodTickets: number[] = [];
  let totalEffectiveDurationMinutes = 0;
  let totalInactiveDurationMinutes = 0;
  let inactiveCheckoutCount = 0;

  const paymentTotals = new Map<DashboardAnalyticsPaymentMethod["method"], { revenue: number; count: number }>();

  for (const row of checkoutRows) {
    const parts = localPartsOf(row.settled_at, timeZone);
    if (!parts) continue;
    const total = Math.round(row.total);
    const breakdown = computeCheckoutDurationBreakdown(
      sessionsByCheckout.get(row.id) ?? [],
      row.duration_minutes ?? 0,
      { capMs: normalizeStayCapHours(facts.stayCapHours) * 3_600_000 },
    );
    const { date } = parts;

    if (date === actualToday) {
      todayRevenueTotal = addAmounts(todayRevenueTotal, total);
      todayCheckoutCount += 1;
      if (breakdown.hasTimedSession) todayEffectiveDurations.push(breakdown.effectiveMinutes);
    } else if (date === actualYesterday) {
      yesterdayRevenueTotal = addAmounts(yesterdayRevenueTotal, total);
      yesterdayCheckoutCount += 1;
    }

    if (date >= startDate && date <= endDate) {
      periodRevenueTotal = addAmounts(periodRevenueTotal, total);
      periodCheckoutCount += 1;
      periodTickets.push(total);
      totalEffectiveDurationMinutes += breakdown.effectiveMinutes;
      totalInactiveDurationMinutes += breakdown.inactiveMinutes;
      if (breakdown.inactiveMinutes > 0) inactiveCheckoutCount += 1;
      if (breakdown.hasTimedSession) periodEffectiveDurations.push(breakdown.effectiveMinutes);
      const point = dailyMap.get(date);
      if (point) {
        point.revenue = addAmounts(point.revenue, total);
        point.checkouts += 1;
      }
      const method = normalizePaymentMethod(row.payment_method);
      const bucket = paymentTotals.get(method) ?? { revenue: 0, count: 0 };
      bucket.revenue = addAmounts(bucket.revenue, total);
      bucket.count += 1;
      paymentTotals.set(method, bucket);
    } else if (date >= prevStartDate && date < startDate) {
      previousRevenueTotal = addAmounts(previousRevenueTotal, total);
      previousCheckoutCount += 1;
    }
  }

  const dailyVisits = new Map<string, Set<string>>();
  const hourlyVisitsSets = Array.from({ length: 24 }, () => new Set<string>());
  const uniquePeriodPlayers = new Set<string>();

  for (const row of sessionRows) {
    const parts = localPartsOf(row.started_at, timeZone);
    if (!parts) continue;
    const { date, hour } = parts;
    let daySet = dailyVisits.get(date);
    if (!daySet) {
      daySet = new Set<string>();
      dailyVisits.set(date, daySet);
    }
    daySet.add(row.player_id);

    if (date >= startDate && date <= endDate) {
      uniquePeriodPlayers.add(row.player_id);
      hourlyVisitsSets[hour]!.add(`${date}:${row.player_id}`);
    }
  }

  let periodVisitCount = 0;
  for (const point of daily) {
    const visits = dailyVisits.get(point.date)?.size ?? 0;
    point.visits = visits;
    periodVisitCount += visits;
  }

  let todayNewPlayerCount = 0;
  let periodNewPlayerCount = 0;
  for (const row of playerRows) {
    const parts = localPartsOf(row.created_at, timeZone);
    if (!parts) continue;
    if (parts.date >= startDate && parts.date <= endDate) {
      periodNewPlayerCount += 1;
    }
    if (parts.date === actualToday) todayNewPlayerCount += 1;
  }

  let todayCoinCount = 0;
  let periodCoinCount = 0;
  const periodSignals: (typeof operationRows)[number][] = [];

  for (const row of operationRows) {
    const parts = localPartsOf(row.requested_at, timeZone);
    if (!parts || parts.date < startDate || parts.date > endDate) continue;

    if (row.action === "coin") {
      periodCoinCount += 1;
      if (parts.date === actualToday) todayCoinCount += 1;
      const point = dailyMap.get(parts.date);
      if (point) point.coins += 1;
    }

    periodSignals.push(row);
  }

  const paymentMethods: DashboardAnalyticsPaymentMethod[] = [...paymentTotals.entries()]
    .filter(([, bucket]) => bucket.count > 0)
    .map(([method, bucket]) => ({ method, revenue: bucket.revenue, count: bucket.count }))
    .sort(
      (a, b) =>
        b.revenue - a.revenue ||
        b.count - a.count ||
        PAYMENT_METHOD_ORDER.indexOf(a.method) - PAYMENT_METHOD_ORDER.indexOf(b.method),
    );

  const { topDevices, topDevicesByHeat } = rankReportDevices(periodSignals);

  const todayDurationSum = todayEffectiveDurations.reduce((sum, value) => sum + value, 0);
  const periodDurationSum = periodEffectiveDurations.reduce((sum, value) => sum + value, 0);

  return {
    range: {
      days,
      timeZone,
      from: facts.range.from,
      to: facts.range.to,
      startDate,
      endDate,
    },
    today: {
      revenueTotal: todayRevenueTotal / 100,
      yesterdayRevenueTotal: yesterdayRevenueTotal / 100,
      checkoutCount: todayCheckoutCount,
      yesterdayCheckoutCount,
      visitCount: dailyVisits.get(actualToday)?.size ?? 0,
      yesterdayVisitCount: dailyVisits.get(actualYesterday)?.size ?? 0,
      newPlayerCount: todayNewPlayerCount,
      coinCount: todayCoinCount,
      avgDurationMinutes: todayEffectiveDurations.length > 0 ? Math.round(todayDurationSum / todayEffectiveDurations.length) : 0,
      medianDurationMinutes: todayEffectiveDurations.length > 0 ? Math.round(computeMedian(todayEffectiveDurations)) : 0,
    },
    period: {
      revenueTotal: periodRevenueTotal / 100,
      previousRevenueTotal: previousRevenueTotal / 100,
      checkoutCount: periodCheckoutCount,
      previousCheckoutCount,
      visitCount: periodVisitCount,
      uniquePlayerCount: uniquePeriodPlayers.size,
      newPlayerCount: periodNewPlayerCount,
      avgTicket: periodCheckoutCount > 0
        ? Math.round((periodRevenueTotal as number) / periodCheckoutCount) / 100
        : 0,
      medianTicket: periodTickets.length > 0
        ? Math.round(computeMedian(periodTickets)) / 100
        : 0,
      avgDurationMinutes: periodEffectiveDurations.length > 0 ? Math.round(periodDurationSum / periodEffectiveDurations.length) : 0,
      medianDurationMinutes: periodEffectiveDurations.length > 0 ? Math.round(computeMedian(periodEffectiveDurations)) : 0,
      totalEffectiveDurationMinutes,
      totalInactiveDurationMinutes,
      inactiveCheckoutCount,
      coinCount: periodCoinCount,
      assetGrantCount: facts.assetGrantCount,
    },
    daily: daily.map((p) => ({ ...p, revenue: p.revenue / 100 })),
    hourlyVisits: hourlyVisitsSets.map((set) => set.size),
    paymentMethods: paymentMethods.map((p) => ({ ...p, revenue: p.revenue / 100 })),
    topDevices,
    topDevicesByHeat,
  };
}
