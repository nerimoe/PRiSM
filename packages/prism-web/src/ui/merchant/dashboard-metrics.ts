import type { Resource, ResourceOccupancyView } from "../../api";
import type { BoardState, BoardStates } from "./board-state";
import {
  deviceActions,
  isDirectConnect,
  resourceCapabilities,
  type CapabilityId,
} from "./resource-capabilities";
import { tileView, type TileView } from "./resource-tile";

export type DashboardAnalyticsRange = {
  days: number;
  timeZone: string;
  from: string;
  to: string;
  startDate: string;
  endDate: string;
};

export type DashboardAnalyticsDailyPoint = {
  date: string;
  revenue: number;
  checkouts: number;
  visits: number;
  coins: number;
};

export type DashboardAnalyticsPaymentMethod = {
  method: "balance" | "wechat" | "alipay" | "cash" | "other";
  revenue: number;
  count: number;
};


export type DashboardAnalyticsDeviceActivity = {
  deviceId: string;
  operations: number;
  coins: number;
  swipes: number;
  visits: number;
  /** Deduplicated plays across coin, swipe, visit and play signals. */
  plays: number;
  /** Distinct identified players. */
  players: number;
};

export type DashboardAnalytics = {
  range: DashboardAnalyticsRange;
  today: {
    revenueTotal: number;
    yesterdayRevenueTotal: number;
    checkoutCount: number;
    yesterdayCheckoutCount: number;
    visitCount: number;
    yesterdayVisitCount: number;
    newPlayerCount: number;
    coinCount: number;
    avgDurationMinutes: number;
    medianDurationMinutes: number;
  };
  period: {
    revenueTotal: number;
    previousRevenueTotal: number;
    checkoutCount: number;
    previousCheckoutCount: number;
    visitCount: number;
    uniquePlayerCount: number;
    newPlayerCount: number;
    avgTicket: number;
    medianTicket: number;
    avgDurationMinutes: number;
    medianDurationMinutes: number;
    totalEffectiveDurationMinutes: number;
    totalInactiveDurationMinutes: number;
    inactiveCheckoutCount: number;
    coinCount: number;
    assetGrantCount: number;
  };
  daily: DashboardAnalyticsDailyPoint[];
  hourlyVisits: number[];
  paymentMethods: DashboardAnalyticsPaymentMethod[];
  topDevices: DashboardAnalyticsDeviceActivity[];
  topDevicesByHeat: DashboardAnalyticsDeviceActivity[];
};

export type DeltaIndicator = {
  direction: "up" | "down" | "flat";
  percent: number | null;
  text: string;
};

/** Percentage change between two non-negative counters or amounts. */
export function deltaIndicator(current: number, previous: number): DeltaIndicator {
  if (previous <= 0) {
    if (current <= 0) return { direction: "flat", percent: 0, text: "0%" };
    return { direction: "up", percent: null, text: "" };
  }
  const raw = ((current - previous) / previous) * 100;
  const rounded = Math.round(raw * 10) / 10;
  if (Math.abs(rounded) < 0.1) return { direction: "flat", percent: 0, text: "0%" };
  const formatted = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return {
    direction: rounded > 0 ? "up" : "down",
    percent: rounded,
    text: `${rounded > 0 ? "+" : ""}${formatted}%`,
  };
}

export type DashboardDeviceItem = {
  device: Resource;
  caps: Record<CapabilityId, boolean>;
  view: TileView;
  hasControls: boolean;
  occupantCount: number;
  alert: boolean;
  running: boolean;
};

export type DashboardDeviceSummary = {
  total: number;
  disabledCount: number;
  running: number;
  poweredOn: number;
  occupied: number;
  totalOccupants: number;
  ioOnline: number;
  ioTotal: number;
  botOnline: number;
  botTotal: number;
  alertCount: number;
  countingDownCount: number;
  items: DashboardDeviceItem[];
};

/**
 * Aggregate essential hardware health, power, occupancy, and alert counts for
 * the merchant homepage without hiding devices that need attention.
 */
export function summarizeDashboardDevices(
  devices: readonly Resource[],
  states: BoardStates | null,
  occupancy: Readonly<Record<string, ResourceOccupancyView>>,
  powerOffAt: Readonly<Record<string, string>>,
  stateFailed: boolean,
): DashboardDeviceSummary {
  const enabled = devices.filter((device) => !!device.enabled);
  const disabledCount = devices.length - enabled.length;

  let running = 0;
  let poweredOn = 0;
  let occupied = 0;
  let totalOccupants = 0;
  let ioOnline = 0;
  let ioTotal = 0;
  let botOnline = 0;
  let botTotal = 0;
  let alertCount = 0;
  let countingDownCount = 0;

  const ranked: Array<{ priority: number; order: number; item: DashboardDeviceItem }> = [];

  enabled.forEach((device, order) => {
    const caps = resourceCapabilities(device);
    if (caps.bot) {
      botTotal += 1;
      if (device.botOnline === true) botOnline += 1;
    }
    const isBotOnly =
      caps.bot &&
      !caps.power &&
      !caps.climate &&
      !caps.hinata_io &&
      !caps.coin &&
      !caps.door &&
      !caps.table;
    if (isBotOnly) return;

    const view = tileView(
      device,
      states?.[device.id] ?? null,
      occupancy[device.id],
      powerOffAt[device.id],
      stateFailed,
    );
    const hasControls = deviceActions(device).length > 0 || !!caps.table;
    const occupantCount = view.seats?.occupants.length ?? 0;
    const directIo = caps.hinata_io && isDirectConnect(device);
    const alert =
      view.tone === "bad" ||
      (directIo && device.relayOnline === false && view.power?.tone === "on") ||
      (caps.bot && !!device.hasBotToken && device.botOnline === false);
    const isRunning = view.power?.tone === "on" || view.climate?.tone === "on";

    if (isRunning) running += 1;
    if (view.power?.tone === "on") poweredOn += 1;
    if (occupantCount > 0) {
      occupied += 1;
      totalOccupants += occupantCount;
    }
    if (directIo) {
      ioTotal += 1;
      if (device.relayOnline === true) ioOnline += 1;
    }
    if (alert) alertCount += 1;
    if (view.powerOffAt) countingDownCount += 1;

    const priority = alert
      ? 0
      : view.powerOffAt
        ? 1
        : occupantCount > 0
          ? 2
          : isRunning
            ? 3
            : 4;

    ranked.push({
      priority,
      order,
      item: {
        device,
        caps,
        view,
        hasControls,
        occupantCount,
        alert,
        running: isRunning,
      },
    });
  });

  ranked.sort((a, b) => a.priority - b.priority || a.order - b.order);

  return {
    total: ranked.length,
    disabledCount,
    running,
    poweredOn,
    occupied,
    totalOccupants,
    ioOnline,
    ioTotal,
    botOnline,
    botTotal,
    alertCount,
    countingDownCount,
    items: ranked.map((entry) => entry.item),
  };
}

export type PeakHourSummary = {
  hour: number;
  count: number;
  total: number;
  label: string;
};

/** Peak arrival hour across a 24-bucket local-hour array, or null when idle. */
export function peakHourSummary(hourlyVisits: readonly number[]): PeakHourSummary | null {
  if (hourlyVisits.length !== 24) return null;
  let peakHour = 0;
  let peakCount = 0;
  let total = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    const count = Math.max(0, hourlyVisits[hour] ?? 0);
    total += count;
    if (count > peakCount) {
      peakCount = count;
      peakHour = hour;
    }
  }
  if (peakCount === 0) return null;
  return {
    hour: peakHour,
    count: peakCount,
    total,
    label: `${String(peakHour).padStart(2, "0")}:00`,
  };
}

export type PaymentShare = DashboardAnalyticsPaymentMethod & {
  percent: number;
};

/**
 * Payment shares summing cleanly to 100% by largest-remainder allocation so
 * segmented bars never fall short or overflow.
 */
export function paymentShares(methods: readonly DashboardAnalyticsPaymentMethod[]): PaymentShare[] {
  const nonEmpty = methods.filter((entry) => entry.count > 0 || entry.revenue > 0);
  if (!nonEmpty.length) return [];

  const totalRevenue = nonEmpty.reduce((sum, entry) => sum + Math.max(0, entry.revenue), 0);
  const totalCount = nonEmpty.reduce((sum, entry) => sum + Math.max(0, entry.count), 0);
  const useRevenue = totalRevenue > 0;
  const basis = useRevenue ? totalRevenue : totalCount;
  if (basis <= 0) return nonEmpty.map((entry) => ({ ...entry, percent: 0 }));

  const exact = nonEmpty.map((entry, index) => {
    const weight = Math.max(0, useRevenue ? entry.revenue : entry.count);
    const quota = (weight / basis) * 100;
    const floor = Math.floor(quota);
    return { index, floor, remainder: quota - floor };
  });

  let remaining = 100 - exact.reduce((sum, item) => sum + item.floor, 0);
  const byRemainder = [...exact].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  const percents = exact.map((item) => item.floor);
  for (let i = 0; i < remaining; i += 1) {
    const target = byRemainder[i % byRemainder.length]!.index;
    percents[target] = percents[target]! + 1;
  }

  return nonEmpty.map((entry, index) => ({
    ...entry,
    percent: percents[index]!,
  }));
}

/** Compute signed local day difference (`endDate - startDate`) for `YYYY-MM-DD` strings. */
export function diffLocalDays(startDate: string, endDate: string): number {
  const valid = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y, m, d] = value.split("-").map(Number);
    const ms = Date.UTC(y!, m! - 1, d!);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() !== m! - 1 ||
      check.getUTCDate() !== d
    ) {
      return null;
    }
    return ms;
  };
  const a = valid(startDate);
  const b = valid(endDate);
  if (a === null || b === null) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/** Break minutes into whole hours and minutes, or null when zero/invalid. */
export function formatDurationSummary(minutes: number): { hours: number; minutes: number } | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.round(minutes);
  return {
    hours: Math.floor(rounded / 60),
    minutes: rounded % 60,
  };
}

/**
 * Concise dashboard device overview label for a direct HINATA IO link.
 * Only flags missing readers when IO is online with 0 readers; when readers are
 * online (`readers > 0`) it omits the reader count.
 */
export function ioStatusLabel(io: NonNullable<TileView["io"]>): string {
  if (io.tone === "off") return "IO 离线";
  if (io.tone === "on") return io.readers === 0 ? "无读卡器" : "IO 在线";
  return "IO 连接未知";
}
