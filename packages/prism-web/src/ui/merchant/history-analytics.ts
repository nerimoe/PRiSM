import type { StaffReportsAnalyticsSource } from "@prism/application";
import { addLocalDays, formatLocalDate, formatOffsetTimestamp, timestampDisplayParts } from "@prism/core";
import type { DashboardAnalytics, DashboardAnalyticsDailyPoint, DashboardAnalyticsPaymentMethod, DashboardAnalyticsDeviceActivity } from "./dashboard-metrics";
const addAmounts = (a: number, b: number) => a + b;
function parseStoredInstant(value: string): Date | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
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

  let todayRevenueTotal = 0;
  let yesterdayRevenueTotal = 0;
  let todayCheckoutCount = 0;
  let yesterdayCheckoutCount = 0;
  let todayDurationSum = 0;

  let periodRevenueTotal = 0;
  let previousRevenueTotal = 0;
  let periodCheckoutCount = 0;
  let previousCheckoutCount = 0;
  let periodDurationSum = 0;

  const paymentTotals = new Map<DashboardAnalyticsPaymentMethod["method"], { revenue: number; count: number }>();

  for (const row of checkoutRows) {
    const parts = localPartsOf(row.settled_at, timeZone);
    if (!parts) continue;
    const total = Math.round(row.total);
    const duration = Math.max(0, Math.round(row.duration_minutes ?? 0));
    const { date } = parts;

    if (date === actualToday) {
      todayRevenueTotal = addAmounts(todayRevenueTotal, total);
      todayCheckoutCount += 1;
      todayDurationSum += duration;
    } else if (date === actualYesterday) {
      yesterdayRevenueTotal = addAmounts(yesterdayRevenueTotal, total);
      yesterdayCheckoutCount += 1;
    }

    if (date >= startDate && date <= endDate) {
      periodRevenueTotal = addAmounts(periodRevenueTotal, total);
      periodCheckoutCount += 1;
      periodDurationSum += duration;
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
  const deviceMap = new Map<string, DashboardAnalyticsDeviceActivity>();

  for (const row of operationRows) {
    const parts = localPartsOf(row.requested_at, timeZone);
    if (!parts || parts.date < startDate || parts.date > endDate) continue;

    if (row.action === "coin") {
      periodCoinCount += 1;
      if (parts.date === actualToday) todayCoinCount += 1;
      const point = dailyMap.get(parts.date);
      if (point) point.coins += 1;
    }

    if (
      row.device_id &&
      row.status !== "failed" &&
      (row.counts_as_play === 1 ||
        row.action === "coin" ||
        row.action === "aime.scan" ||
        row.action === "power.on" ||
        row.action === "mahjong.seat")
    ) {
      const activity = deviceMap.get(row.device_id) ?? {
        deviceId: row.device_id,
        operations: 0,
        coins: 0,
        swipes: 0,
      };
      activity.operations += 1;
      if (row.action === "coin") activity.coins += 1;
      if (row.action === "aime.scan") activity.swipes += 1;
      deviceMap.set(row.device_id, activity);
    }
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

  const topDevices = [...deviceMap.values()]
    .sort((a, b) => b.operations - a.operations || b.coins - a.coins || a.deviceId.localeCompare(b.deviceId))
    .slice(0, 5);

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
      avgDurationMinutes: todayCheckoutCount > 0 ? Math.round(todayDurationSum / todayCheckoutCount) : 0,
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
      avgDurationMinutes: periodCheckoutCount > 0 ? Math.round(periodDurationSum / periodCheckoutCount) : 0,
      coinCount: periodCoinCount,
      assetGrantCount: facts.assetGrantCount,
    },
    daily: daily.map(p => ({ ...p, revenue: p.revenue / 100 })),
    hourlyVisits: hourlyVisitsSets.map((set) => set.size),
    paymentMethods: paymentMethods.map(p => ({ ...p, revenue: p.revenue / 100 })),
    topDevices,
  };
}
