import { describe, expect, it } from "vitest";
import type { Resource, ResourceOccupancyView } from "../../api";
import {
  deltaIndicator,
  diffLocalDays,
  formatDurationSummary,
  paymentShares,
  peakHourSummary,
  summarizeDashboardDevices,
} from "./dashboard-metrics";

const machine = (over: Partial<Resource> = {}): Resource => ({
  id: "m1",
  publicId: "p1",
  shopId: "s1",
  shopPublicId: "shop",
  name: "机台",
  aliases: [],
  enabled: true,
  kind: "machine",
  hasHinata: false,
  hinataUrl: null,
  homeAssistant: null,
  ttlockLockId: null,
  mahjong: null,
  coinKey: 0,
  coinAfterSwipe: false,
  relayConnection: "external",
  ...over,
});

describe("dashboard metrics", () => {
  it("computes delta indicators with zero-base handling", () => {
    expect(deltaIndicator(0, 0)).toEqual({ direction: "flat", percent: 0, text: "0%" });
    expect(deltaIndicator(120, 0)).toEqual({ direction: "up", percent: null, text: "" });
    expect(deltaIndicator(125, 100)).toEqual({ direction: "up", percent: 25, text: "+25%" });
    expect(deltaIndicator(75, 100)).toEqual({ direction: "down", percent: -25, text: "-25%" });
    expect(deltaIndicator(100.01, 100)).toEqual({ direction: "flat", percent: 0, text: "0%" });
  });

  it("summarizes device health, occupancy, and alert priority", () => {
    const devices: Resource[] = [
      machine({
        id: "idle",
        name: "空闲机台",
        homeAssistant: { url: "https://ha", entityId: "switch.idle" },
      }),
      machine({
        id: "occ",
        name: "占用机台",
        homeAssistant: { url: "https://ha", entityId: "switch.occ" },
        relayConnection: "embedded",
        relayOnline: true,
        io: { version: "1.3.0", readers: 1, credit: 4 },
      }),
      machine({
        id: "fault",
        name: "无读卡器机台",
        relayConnection: "embedded",
        relayOnline: true,
        io: { version: "1.3.0", readers: 0, credit: 2 },
      }),
      machine({
        id: "bot_off",
        name: "店铺 Bot",
        hasBotToken: true,
        botOnline: false,
        bot: {
          playerCommands: "all",
          readOnlyNotice: "",
          staffCommands: true,
          powerOffStaffOnly: false,
          doorResourceId: null,
          doorPasswordOnEntry: false,
          announceGroups: [],
          idleReminderMinutes: 5,
        },
      }),
      machine({ id: "disabled", name: "停用设备", enabled: false }),
    ];

    const states = {
      idle: { watching: true, power: "off" as const },
      occ: { watching: true, power: "on" as const },
    };
    const occupancy: Record<string, ResourceOccupancyView> = {
      occ: {
        resourceId: "occ",
        capacity: 1,
        source: "hinata_io",
        occupants: [
          {
            playerId: "p1",
            displayName: "玩家一",
            startedAt: "2026-11-22T10:00:00Z",
            lastSeenAt: "2026-11-22T10:15:00Z",
            expiresAt: null,
            billing: true,
          },
        ],
      },
    };
    const summary = summarizeDashboardDevices(
      devices,
      states,
      occupancy,
      { idle: "2026-11-22T12:00:00Z" },
      false,
    );

    expect(summary.total).toBe(4);
    expect(summary.disabledCount).toBe(1);
    // Both `occ` (powered on + occupied) and `fault` (direct IO online without power binding) are lit/running.
    expect(summary.running).toBe(2);
    expect(summary.poweredOn).toBe(1);
    expect(summary.occupied).toBe(1);
    expect(summary.totalOccupants).toBe(1);
    expect(summary.ioOnline).toBe(2);
    expect(summary.ioTotal).toBe(2);
    expect(summary.botOnline).toBe(0);
    expect(summary.botTotal).toBe(1);
    expect(summary.alertCount).toBe(2);
    expect(summary.countingDownCount).toBe(0);
    // Alerts come first, then occupied, then idle.
    expect(summary.items.map((item) => item.device.id)).toEqual([
      "fault",
      "bot_off",
      "occ",
      "idle",
    ]);
  });

  it("finds peak arrival hour and normalizes payment shares to 100%", () => {
    const hours = Array.from({ length: 24 }, () => 0);
    expect(peakHourSummary(hours)).toBeNull();
    hours[19] = 14;
    hours[14] = 8;
    expect(peakHourSummary(hours)).toEqual({
      hour: 19,
      count: 14,
      total: 22,
      label: "19:00",
    });

    const shares = paymentShares([
      { method: "balance", revenue: 33.33, count: 1 },
      { method: "wechat", revenue: 33.33, count: 1 },
      { method: "cash", revenue: 33.34, count: 1 },
    ]);
    expect(shares.reduce((sum, s) => sum + s.percent, 0)).toBe(100);
    expect(formatDurationSummary(0)).toBeNull();
    expect(formatDurationSummary(135)).toEqual({ hours: 2, minutes: 15 });
    expect(diffLocalDays("2026-11-16", "2026-11-22")).toBe(6);
    expect(diffLocalDays("2026-11-22", "2026-11-22")).toBe(0);
    expect(diffLocalDays("2026-11-23", "2026-11-22")).toBe(-1);
    expect(Number.isNaN(diffLocalDays("2026-02-30", "2026-03-01"))).toBe(true);
  });
});
