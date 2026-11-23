/**
 * Pure analytics helpers for merchant historical reports: effective stay
 * clipping (a stay counts in full up to the shop's cap; anything past it is a
 * forgotten checkout), overlapping-session interval merging, and median
 * aggregation.
 */

/**
 * Every stay is effective in full up to this many hours after it starts; only
 * what runs past it counts as a forgotten checkout. Activity events are not
 * used: many shops run games that never reach the platform (an arcade cabinet
 * beside a platform mahjong table), so a player's last event says nothing
 * about when they left. The median headline absorbs the rare forgotten
 * checkout that stays under the cap. Shops change it in
 * `reports.settings` → `stayCapHours`.
 */
export const DEFAULT_STAY_CAP_HOURS = 12;
export const MIN_STAY_CAP_HOURS = 1;
export const MAX_STAY_CAP_HOURS = 72;
export const DEFAULT_STAY_CAP_MS = DEFAULT_STAY_CAP_HOURS * 60 * 60_000;

/** Clamp a stored `stayCapHours` setting to its allowed range, falling back to the default. */
export function normalizeStayCapHours(value: unknown): number {
  const hours = typeof value === "number" ? value : value == null || value === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(hours)) return DEFAULT_STAY_CAP_HOURS;
  return Math.min(MAX_STAY_CAP_HOURS, Math.max(MIN_STAY_CAP_HOURS, Math.round(hours)));
}

export function parseReportTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function computeMedian(values: readonly number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mergeIntervals(intervals: readonly [number, number][]): [number, number][] {
  const valid = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(([start, end]): [number, number] => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of valid) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export type EffectiveSessionInterval = {
  startMs: number;
  effectiveEndMs: number;
  endMs: number;
  effectiveMs: number;
  inactiveMs: number;
  rawMs: number;
};

/**
 * Split one session `[startedAtMs, endedAtMs]` into effective time, up to
 * `startedAtMs + capMs` (default 12 hours), and the inactive tail after it.
 */
export function clipSessionEffectiveInterval(input: {
  startedAtMs: number;
  endedAtMs: number;
  capMs?: number;
}): EffectiveSessionInterval {
  const startMs = input.startedAtMs;
  const endMs = Math.max(startMs, input.endedAtMs);
  const effectiveEndMs = Math.min(endMs, startMs + (input.capMs ?? DEFAULT_STAY_CAP_MS));
  const rawMs = endMs - startMs;
  const effectiveMs = Math.max(0, effectiveEndMs - startMs);
  const inactiveMs = Math.max(0, endMs - effectiveEndMs);
  return { startMs, effectiveEndMs, endMs, effectiveMs, inactiveMs, rawMs };
}

export type CheckoutSessionTiming = {
  startedAtMs: number;
  endedAtMs: number;
};

export type CheckoutDurationBreakdown = {
  rawMinutes: number;
  effectiveMinutes: number;
  inactiveMinutes: number;
  hasTimedSession: boolean;
};

/**
 * Compute deduplicated effective and inactive duration for a checkout across
 * its linked sessions, merging overlapping spans before clipping each one at
 * the stay cap.
 */
export function computeCheckoutDurationBreakdown(
  sessions: readonly CheckoutSessionTiming[],
  fallbackRawMinutes = 0,
  options: { capMs?: number } = {},
): CheckoutDurationBreakdown {
  const valid = sessions
    .filter(
      (session) =>
        Number.isFinite(session.startedAtMs) &&
        Number.isFinite(session.endedAtMs) &&
        session.endedAtMs > session.startedAtMs,
    )
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.endedAtMs - b.endedAtMs);

  if (valid.length === 0) {
    const raw = Math.max(0, Math.round(fallbackRawMinutes));
    return {
      rawMinutes: raw,
      effectiveMinutes: raw,
      inactiveMinutes: 0,
      hasTimedSession: raw > 0,
    };
  }

  let effectiveMs = 0;
  let rawMs = 0;
  for (const [startMs, endMs] of mergeIntervals(valid.map((item) => [item.startedAtMs, item.endedAtMs]))) {
    const clipped = clipSessionEffectiveInterval({ startedAtMs: startMs, endedAtMs: endMs, capMs: options.capMs });
    effectiveMs += clipped.effectiveMs;
    rawMs += clipped.rawMs;
  }

  const rawMinutes = Math.round(rawMs / 60_000);
  const effectiveMinutes = Math.round(effectiveMs / 60_000);
  return {
    rawMinutes,
    effectiveMinutes,
    inactiveMinutes: Math.max(0, rawMinutes - effectiveMinutes),
    hasTimedSession: rawMs > 0,
  };
}

/**
 * One device-level signal from the report fact batch: a device operation, a
 * physical card read (`aime.scan`) or a logged-in resource-page visit
 * (`resource.visited`). `player_id` is optional so older fact batches still rank.
 */
export type ReportDeviceSignal = {
  device_id: string | null;
  player_id?: string | null;
  action: string;
  status: string;
  counts_as_play: number;
  requested_at: string;
};

export type ReportDeviceActivity = {
  deviceId: string;
  operations: number;
  coins: number;
  swipes: number;
  visits: number;
  /** Deduplicated play count: the combined heat ranking's primary value. */
  plays: number;
  /** Distinct identified players behind those plays. */
  players: number;
};

/**
 * Signals from the same player on the same device within this window belong
 * to one play: a card swipe that auto-coins, a web visit followed by a coin
 * or a seat, or a double coin for two credits all count once.
 */
export const PLAY_DEDUP_WINDOW_MS = 3 * 60_000;

const PLAY_ACTIONS = new Set(["coin", "aime.scan", "power.on", "table.seat"]);

function isHardwarePlaySignal(row: ReportDeviceSignal): boolean {
  return row.status !== "failed" && (row.counts_as_play === 1 || PLAY_ACTIONS.has(row.action));
}

/**
 * Ranks devices by a combined heat score (and by coins for existing API callers).
 *
 * Heat does not add the raw counters together, because the same play is seen
 * by several signals (swipe + auto-coin, visit + coin) and shops differ in
 * which signals they produce (coin only, card only, tabletop visit only).
 * Instead every coin, swipe, visit and play operation is a hint that someone
 * played; hints from the same player (or the same anonymous source) on the
 * same device that start within {@link PLAY_DEDUP_WINDOW_MS} of the current
 * play are folded into it. The number of plays is therefore comparable across
 * arcade cabinets with or without auto-coin and tables that only see visits.
 * Ties break on distinct players, then on total raw signals.
 */
export function rankReportDevices(rows: readonly ReportDeviceSignal[], limit = 5): {
  /** Coin ranking kept for existing API callers; the merchant UI shows only heat. */
  topDevices: ReportDeviceActivity[];
  topDevicesByHeat: ReportDeviceActivity[];
} {
  const devices = new Map<string, ReportDeviceActivity>();
  const hints = new Map<string, Map<string, number[]>>();
  const playerSets = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!row.device_id) continue;
    const isVisit = row.action === "resource.visited";
    const isPlay = !isVisit && isHardwarePlaySignal(row);
    if (!isVisit && !isPlay) continue;
    const activity = devices.get(row.device_id) ?? {
      deviceId: row.device_id, operations: 0, coins: 0, swipes: 0, visits: 0, plays: 0, players: 0,
    };
    devices.set(row.device_id, activity);
    if (isVisit) {
      activity.visits += 1;
    } else {
      activity.operations += 1;
      if (row.action === "coin") activity.coins += 1;
      if (row.action === "aime.scan") activity.swipes += 1;
    }
    const at = parseReportTimestampMs(row.requested_at);
    if (at === null) continue;
    const who = row.player_id ?? "";
    if (who) {
      const set = playerSets.get(row.device_id) ?? new Set<string>();
      set.add(who);
      playerSets.set(row.device_id, set);
    }
    const byWho = hints.get(row.device_id) ?? new Map<string, number[]>();
    hints.set(row.device_id, byWho);
    const list = byWho.get(who) ?? [];
    list.push(at);
    byWho.set(who, list);
  }

  for (const [deviceId, byWho] of hints) {
    const activity = devices.get(deviceId)!;
    let plays = 0;
    for (const times of byWho.values()) {
      times.sort((a, b) => a - b);
      let playStart = Number.NEGATIVE_INFINITY;
      for (const at of times) {
        if (at - playStart >= PLAY_DEDUP_WINDOW_MS) {
          plays += 1;
          playStart = at;
        }
      }
    }
    activity.plays = plays;
    activity.players = playerSets.get(deviceId)?.size ?? 0;
  }

  const all = [...devices.values()];
  const rank = (
    metric: (entry: ReportDeviceActivity) => number,
    tie: (a: ReportDeviceActivity, b: ReportDeviceActivity) => number = () => 0,
  ) =>
    all
      .filter((entry) => metric(entry) > 0)
      .sort((a, b) => metric(b) - metric(a) || tie(a, b) || a.deviceId.localeCompare(b.deviceId))
      .slice(0, limit);

  return {
    topDevices: rank((entry) => entry.coins),
    topDevicesByHeat: rank(
      (entry) => entry.plays,
      (a, b) => b.players - a.players || (b.operations + b.visits) - (a.operations + a.visits),
    ),
  };
}
