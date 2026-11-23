import { describe, expect, it } from "bun:test";
import {
  clipSessionEffectiveInterval,
  computeCheckoutDurationBreakdown,
  computeMedian,
  DEFAULT_STAY_CAP_MS,
  mergeIntervals,
  normalizeStayCapHours,
  parseReportTimestampMs,
  rankReportDevices,
} from "../src";

const HOUR = 60 * 60_000;
const MIN = 60_000;

describe("report analytics helpers", () => {
  it("computes medians across empty, odd, and even inputs", () => {
    expect(computeMedian([])).toBe(0);
    expect(computeMedian([Number.NaN])).toBe(0);
    expect(computeMedian([30, 10, 20])).toBe(20);
    expect(computeMedian([40, 10, 30, 20])).toBe(25);
    expect(computeMedian([5, 5, 1000])).toBe(5);
  });

  it("parses SQLite and ISO timestamps", () => {
    expect(parseReportTimestampMs("2026-11-20 10:00:00")).toBe(Date.parse("2026-11-20T10:00:00Z"));
    expect(parseReportTimestampMs("2026-11-20T10:30:00.000Z")).toBe(Date.parse("2026-11-20T10:30:00Z"));
    expect(parseReportTimestampMs(null)).toBeNull();
    expect(parseReportTimestampMs("nope")).toBeNull();
  });

  it("merges overlapping intervals cleanly", () => {
    expect(
      mergeIntervals([
        [200, 300],
        [100, 200],
        [400, 500],
        [450, 480],
        [600, 600],
      ]),
    ).toEqual([
      [100, 300],
      [400, 500],
    ]);
  });

  it("counts a stay in full up to the cap and the rest as a forgotten checkout", () => {
    const start = Date.parse("2026-11-20T10:00:00Z");

    // A 5h stay (say, mahjong then arcade games the platform never sees) -> fully effective.
    const normal = clipSessionEffectiveInterval({ startedAtMs: start, endedAtMs: start + 5 * HOUR });
    expect(normal.effectiveMs).toBe(5 * HOUR);
    expect(normal.inactiveMs).toBe(0);

    // A 3-day forgotten checkout -> effective up to the 12h default cap.
    const zombie = clipSessionEffectiveInterval({ startedAtMs: start, endedAtMs: start + 72 * HOUR });
    expect(zombie.effectiveEndMs).toBe(start + DEFAULT_STAY_CAP_MS);
    expect(zombie.effectiveMs).toBe(12 * HOUR);
    expect(zombie.inactiveMs).toBe(60 * HOUR);

    // The shop's own cap replaces the default.
    const custom = clipSessionEffectiveInterval({ startedAtMs: start, endedAtMs: start + 5 * HOUR, capMs: 4 * HOUR });
    expect(custom.effectiveMs).toBe(4 * HOUR);
    expect(custom.inactiveMs).toBe(HOUR);

    // An end before the start is an empty stay.
    expect(clipSessionEffectiveInterval({ startedAtMs: start, endedAtMs: start - HOUR }).rawMs).toBe(0);
  });

  it("normalizes the stay cap setting", () => {
    expect(normalizeStayCapHours(undefined)).toBe(12);
    expect(normalizeStayCapHours("abc")).toBe(12);
    expect(normalizeStayCapHours(0)).toBe(1);
    expect(normalizeStayCapHours(500)).toBe(72);
    expect(normalizeStayCapHours(8.4)).toBe(8);
  });

  it("deduplicates overlapping checkout sessions and clips disjoint sessions independently", () => {
    const base = Date.parse("2026-11-20T10:00:00Z");

    // Overlapping entry + table sessions count once: 10h merged span, all under the 12h cap.
    const overlapping = computeCheckoutDurationBreakdown([
      { startedAtMs: base, endedAtMs: base + 10 * HOUR },
      { startedAtMs: base + 30 * MIN, endedAtMs: base + 3 * HOUR },
    ]);
    expect(overlapping).toEqual({ rawMinutes: 600, effectiveMinutes: 600, inactiveMinutes: 0, hasTimedSession: true });

    // A merged span past the cap is clipped once, not per session.
    const longOverlap = computeCheckoutDurationBreakdown([
      { startedAtMs: base, endedAtMs: base + 20 * HOUR },
      { startedAtMs: base + HOUR, endedAtMs: base + 2 * HOUR },
    ]);
    expect(longOverlap).toEqual({ rawMinutes: 1200, effectiveMinutes: 720, inactiveMinutes: 480, hasTimedSession: true });

    // Disjoint sessions in one checkout clip independently against the shop's cap.
    const disjoint = computeCheckoutDurationBreakdown(
      [
        { startedAtMs: base, endedAtMs: base + 4 * HOUR },
        { startedAtMs: base + 6 * HOUR, endedAtMs: base + 7 * HOUR },
      ],
      0,
      { capMs: 2 * HOUR },
    );
    expect(disjoint).toEqual({ rawMinutes: 300, effectiveMinutes: 180, inactiveMinutes: 120, hasTimedSession: true });

    // Fallback when checkout has no linked sessions.
    expect(computeCheckoutDurationBreakdown([], 45)).toEqual({
      rawMinutes: 45,
      effectiveMinutes: 45,
      inactiveMinutes: 0,
      hasTimedSession: true,
    });
    expect(computeCheckoutDurationBreakdown([], 0)).toEqual({
      rawMinutes: 0,
      effectiveMinutes: 0,
      inactiveMinutes: 0,
      hasTimedSession: false,
    });
  });
});

describe("rankReportDevices heat", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 10, minute)).toISOString();
  const sig = (device: string, action: string, minute: number, player: string | null = "p1", status = "succeeded") => ({
    device_id: device, player_id: player, action, status,
    counts_as_play: action === "resource.visited" ? 0 : action === "aime.scan" ? 1 : 0, requested_at: at(minute),
  });

  it("folds a swipe with its auto-coin, and a visit with its coin, into one play", () => {
    const ranked = rankReportDevices([
      // auto-coin cabinet: physical card swipe immediately coins, no web visit
      sig("auto", "aime.scan", 0), sig("auto", "coin", 0),
      sig("auto", "aime.scan", 10, "p2"), sig("auto", "coin", 10, "p2"), sig("auto", "coin", 11, "p2"),
      // web cabinet: visit then coin
      sig("web", "resource.visited", 0), sig("web", "coin", 1),
    ]);
    expect(ranked.topDevicesByHeat.map((d) => [d.deviceId, d.plays, d.players])).toEqual([
      ["auto", 2, 2],
      ["web", 1, 1],
    ]);
  });

  it("ranks coin-only, swipe-only and visit-only devices on the same scale", () => {
    const ranked = rankReportDevices([
      sig("coinOnly", "coin", 0, null), sig("coinOnly", "coin", 5, null), sig("coinOnly", "coin", 10, null),
      sig("swipeOnly", "aime.scan", 0, null), sig("swipeOnly", "aime.scan", 4, null),
      sig("table", "resource.visited", 0, "a"), sig("table", "resource.visited", 0, "b"),
      sig("table", "resource.visited", 1, "c"), sig("table", "resource.visited", 2, "d"),
    ]);
    expect(ranked.topDevicesByHeat.map((d) => [d.deviceId, d.plays])).toEqual([
      ["table", 4],
      ["coinOnly", 3],
      ["swipeOnly", 2],
    ]);
  });

  it("splits long sessions into separate plays and ignores failed operations", () => {
    const ranked = rankReportDevices([
      sig("cab", "coin", 0), sig("cab", "coin", 2), sig("cab", "coin", 3), sig("cab", "coin", 7),
      sig("cab", "coin", 8, "p1", "failed"),
    ]);
    expect(ranked.topDevicesByHeat[0]).toMatchObject({ plays: 3, coins: 4, operations: 4 });
  });
});
