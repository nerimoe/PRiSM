/**
 * Idle power-off: timers the shop hub keeps, moved by what happens and by
 * nothing else. This module is the timers; the hub hears the events, keeps the
 * one alarm and switches off (`durable-objects/shop-hub-idle.ts`).
 *
 * A switch that is on has a timer:
 * - switched on starts it;
 * - switched off ends it;
 * - a coin, an authorised card or `keep` starts it again (a card that begins a
 *   stay starts it from the end of that stay);
 * - a table whose seats are taken has none until the last one leaves.
 *
 * Two rules read the timers, both off until the shop turns them on:
 * - **Device idle**: a timer that runs out switches its device off. While the
 *   shop has players the owner chooses: switch it off, or only leave it marked.
 * - **Shop empty**: the last bill closing starts one timer for the whole shop;
 *   when it runs out everything still on is switched off. Whatever is switched
 *   on in the empty shop afterwards runs on its own timer.
 *
 * Running out has two steps when a bot wants to be told: first the warning,
 * said `lead` ahead, then the power-off. Air conditioners go off with the last
 * device. Nothing here reads the shop's state: a timer only knows when it was
 * last moved.
 */
import { z } from "zod";

export const IDLE_SETTINGS_KEY = "devices.idle_power";

export const idleSettingsSchema = z.preprocess(
  // Before idle times moved onto each resource, a device idle time above zero
  // was what turned the device rule on.
  (value) => {
    if (!value || typeof value !== "object") return value;
    const stored = value as { device?: { enabled?: unknown; defaultMinutes?: unknown }; devices?: Record<string, { minutes?: unknown }> };
    if (stored.device && stored.device.enabled === undefined) {
      const legacy = (typeof stored.device.defaultMinutes === "number" && stored.device.defaultMinutes > 0)
        || Object.values(stored.devices ?? {}).some((device) => typeof device?.minutes === "number" && device.minutes > 0);
      const minutes = typeof stored.device.defaultMinutes === "number" && stored.device.defaultMinutes > 0 ? stored.device.defaultMinutes : undefined;
      return { ...stored, device: { ...stored.device, enabled: legacy, ...(minutes ? { minutes } : {}) } };
    }
    return value;
  },
  z.object({
    shopEmpty: z
      .object({
        enabled: z.boolean().default(false),
        minutes: z.number().int().min(1).max(24 * 60).default(15),
      })
      .default({}),
    device: z
      .object({
        enabled: z.boolean().default(false),
        /** How long an idle device waits before automatic shutdown. */
        minutes: z.number().int().min(1).max(24 * 60).default(10),
        // Old reminder-only settings now share the automatic power-off deadline.
        whileOccupied: z.preprocess((value) => value === "remind" ? "off" : value, z.enum(["mark", "off"]).default("mark")),
      })
      .default({}),
    devices: z
      .record(
        z.object({
          /** Never switched off automatically (a router, a lock's supply). */
          exclude: z.boolean().optional(),
        }),
      )
      .default({}),
  }),
);
export type IdleSettings = z.output<typeof idleSettingsSchema>;

export function parseIdleSettings(value: unknown): IdleSettings {
  const parsed = idleSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : idleSettingsSchema.parse({});
}

/** A power-off that failed, or that nothing has confirmed, is sent again after this. */
export const RETRY_OFF_MS = 10 * 60_000;
/** How often a power-off is sent to a device that still reports itself on. */
const MAX_UNCONFIRMED = 3;
/** The alarm is never set closer than this, so nothing left due can spin it. */
const MIN_WAKE_MS = 1000;

/** Unknown HA modes must not look like an air conditioner switching on. */
export function climatePower(state: string | null): "on" | "off" | null {
  return !state || state === "unknown" || state === "unavailable" ? null : state === "off" ? "off" : "on";
}

/**
 * What the hub is told, by resource: the subscriber of the device events says
 * these (`events/subscribers.ts`), as do the routes that change seats or the
 * idle settings. The hub finds which switch a resource is on.
 */
export type IdleSignal =
  | { kind: "on" | "off"; deviceId: string; at?: number }
  /**
   * A coin, an authorised card, `keep`. `stay`: it began or renewed a player's
   * stay on the resource, so the timer starts where that stay ends: a device is
   * not switched off under someone the resource still counts as playing.
   */
  | { kind: "activity"; deviceId: string; at?: number; stay?: boolean }
  /** Home Assistant reports the device switched on, without that being a change. */
  | { kind: "seen"; deviceId: string; at?: number }
  /** A bill started or closed: the shop may have become empty, or stopped being so. */
  | { kind: "sessions" }
  /** A seat was taken or left. */
  | { kind: "seats" }
  /** The idle rules were edited. */
  | { kind: "settings" };

/** One switch that is on, or one resource in use that has none. */
export type IdleEntry = {
  /** Every resource switching it off would affect. */
  ids: string[];
  /** Whether there is a switch to turn off. Without one the timer only counts towards the last device. */
  power: boolean;
  /** When it was last switched on, paid at, or kept, in ms. */
  at: number;
  /** Seats are taken: no timer until they are left. */
  held?: true;
  /** Home Assistant reports its power, so a power-off that took will be heard. */
  seen?: true;
  /** The warning was said; this is when the power-off follows. Also when a failed power-off is sent again. */
  warned?: { offAt: number };
  /** It ran out while players were in and the owner only marks. */
  marked?: true;
  /** Power-offs sent that nothing has confirmed yet. */
  sent?: number;
};

export type IdleTimers = {
  entries: Record<string, IdleEntry>;
  /** Since when no bill is open, in ms; null while one is. */
  emptySince: number | null;
  /** The shop-empty timer of this empty stretch. */
  shop: { warned?: { offAt: number }; done?: true };
  /** An idle power-off happened: the air conditioners follow once nothing is left on. */
  climateDue?: true;
  /** When the hub's alarm is next needed for these. */
  wakeAt: number | null;
};

export const emptyIdleTimers = (): IdleTimers => ({ entries: {}, emptySince: null, shop: {}, wakeAt: null });

/** A signal about a resource, once the hub knows its switch. */
export type IdleEvent =
  | { kind: "on" | "activity"; key: string; ids: string[]; power: boolean; at?: number; seen?: boolean }
  /** It is on and Home Assistant says so; when it was switched on is not news. */
  | { kind: "seen"; key: string; ids: string[]; power: boolean; at?: number }
  | { kind: "off"; key: string }
  | { kind: "held"; key: string; ids: string[]; power: boolean; held: boolean };

const restart = (entry: IdleEntry) => {
  delete entry.warned;
  delete entry.marked;
  delete entry.sent;
};

export function applyIdleEvent(timers: IdleTimers, event: IdleEvent, now: number): void {
  if (event.kind === "off") {
    delete timers.entries[event.key];
    return;
  }
  const known = timers.entries[event.key];
  if (event.kind === "held" && !event.held && !known?.held) return;
  const entry = known ?? { ids: event.ids, power: event.power, at: ("at" in event ? event.at : undefined) ?? now };
  entry.ids = event.ids;
  entry.power = event.power;
  timers.entries[event.key] = entry;
  if (event.kind === "seen") {
    entry.seen = true;
    return;
  }
  if (event.kind === "held") {
    if (event.held) entry.held = true;
    else {
      delete entry.held;
      entry.at = now;
    }
    restart(entry);
    return;
  }
  if (event.seen) entry.seen = true;
  entry.at = Math.max(known ? entry.at : 0, event.at ?? now);
  restart(entry);
}

/** The shop became empty or stopped being so. A marked device is judged again under the other rule. */
export function setIdleEmpty(timers: IdleTimers, empty: boolean, now: number): void {
  if (empty === (timers.emptySince !== null)) return;
  timers.emptySince = empty ? now : null;
  timers.shop = {};
  for (const entry of Object.values(timers.entries)) delete entry.marked;
}

/** The rules were edited: what was decided under the old ones is decided again. */
export function idleSettingsChanged(timers: IdleTimers): void {
  delete timers.shop.warned;
  for (const entry of Object.values(timers.entries)) delete entry.marked;
}

const excluded = (entry: IdleEntry, settings: IdleSettings) => entry.ids.some((id) => settings.devices[id]?.exclude);

/** When an entry runs out and what then happens to it; null while no rule times it. */
function ruleOf(entry: IdleEntry, timers: IdleTimers, settings: IdleSettings): { at: number; action: "off" | "mark" } | null {
  if (entry.held || entry.marked || excluded(entry, settings)) return null;
  if (timers.emptySince !== null && settings.shopEmpty.enabled) {
    // The shop's own timer switches everything off; after it has, each device is on its own.
    if (!timers.shop.done) return null;
    const minutes = settings.device.enabled ? settings.device.minutes : settings.shopEmpty.minutes;
    return { at: entry.at + minutes * 60_000, action: "off" };
  }
  if (!settings.device.enabled) return null;
  return {
    at: entry.at + settings.device.minutes * 60_000,
    action: timers.emptySince === null && settings.device.whileOccupied === "mark" ? "mark" : "off",
  };
}

const shopAt = (timers: IdleTimers, settings: IdleSettings) =>
  settings.shopEmpty.enabled && timers.emptySince !== null && !timers.shop.done
    ? timers.emptySince + settings.shopEmpty.minutes * 60_000 : null;

/** What the shop-empty timer switches off: every switch that is on, free and not excluded. */
const switchable = (timers: IdleTimers, settings: IdleSettings) =>
  Object.entries(timers.entries).filter(([, entry]) => entry.power && !entry.held && !excluded(entry, settings)).map(([key]) => key);

export type IdleReason = "shop_empty" | "device_idle";

export type IdleDue = {
  /** Warnings to say now: these switches go off at `at`. */
  warn: Array<{ reason: IdleReason; keys: string[]; at: number }>;
  /** Switches to turn off now; tell `settleIdleOff` how each went. */
  off: Array<{ reason: IdleReason; key: string }>;
  /** The shop-empty timer ran out: the air conditioners go off with it. */
  shopOff: boolean;
};

/**
 * Everything that has run out by `now`, moved one step on: a timer that reaches
 * its warning is warned about and given `leadMs` more, one whose warning has
 * passed is switched off. Without a lead there is no first step.
 */
export function dueIdle(timers: IdleTimers, settings: IdleSettings, now: number, leadMs: number | null): IdleDue {
  const due: IdleDue = { warn: [], off: [], shopOff: false };
  const lead = leadMs && leadMs > 0 ? leadMs : 0;
  const taken = new Set<string>();
  const shop = shopAt(timers, settings);
  if (shop !== null) {
    const keys = switchable(timers, settings);
    const warned = timers.shop.warned;
    if (!warned && lead && keys.length && now >= shop - lead) {
      const at = Math.max(shop, now + lead);
      timers.shop.warned = { offAt: at };
      due.warn.push({ reason: "shop_empty", keys, at });
    } else if (now >= (warned?.offAt ?? shop)) {
      timers.shop = { done: true };
      due.shopOff = true;
      for (const key of keys) {
        due.off.push({ reason: "shop_empty", key });
        taken.add(key);
      }
    }
  }
  for (const [key, entry] of Object.entries(timers.entries)) {
    if (taken.has(key)) continue;
    const rule = ruleOf(entry, timers, settings);
    if (!rule) {
      // Whatever was pending belonged to a rule that no longer times it.
      delete entry.warned;
      delete entry.sent;
      continue;
    }
    if (entry.warned && now < entry.warned.offAt) continue;
    if (rule.action === "mark") {
      delete entry.warned;
      if (now >= rule.at) entry.marked = true;
      continue;
    }
    if (!entry.power) {
      if (now < rule.at) continue;
      // Nothing to switch off; it stops counting as a device in use.
      delete timers.entries[key];
      timers.climateDue = true;
      continue;
    }
    if (entry.warned) due.off.push({ reason: "device_idle", key });
    else if (lead && now >= rule.at - lead) {
      const at = Math.max(rule.at, now + lead);
      entry.warned = { offAt: at };
      due.warn.push({ reason: "device_idle", keys: [key], at });
    } else if (!lead && now >= rule.at) due.off.push({ reason: "device_idle", key });
  }
  return due;
}

/**
 * How a power-off went. One that failed is sent again later. One that was
 * accepted ends the timer, unless Home Assistant reports the device: then its
 * `off` ends it, and the power-off is repeated a few times while none comes.
 */
export function settleIdleOff(timers: IdleTimers, key: string, ok: boolean, now: number): void {
  const entry = timers.entries[key];
  if (!entry) return;
  if (!ok) {
    entry.warned = { offAt: now + RETRY_OFF_MS };
    return;
  }
  timers.climateDue = true;
  const sent = (entry.sent ?? 0) + 1;
  if (entry.seen && sent < MAX_UNCONFIRMED) {
    entry.sent = sent;
    entry.warned = { offAt: now + RETRY_OFF_MS };
  } else delete timers.entries[key];
}

/** Whether anything that a rule could switch off is still on or in use. */
export function idleBusy(timers: IdleTimers, settings: IdleSettings): boolean {
  return Object.values(timers.entries).some((entry) => !excluded(entry, settings));
}

/** When the alarm is next needed: the earliest warning or power-off ahead. */
export function nextIdleWake(timers: IdleTimers, settings: IdleSettings, now: number, leadMs: number | null): number | null {
  const lead = leadMs && leadMs > 0 ? leadMs : 0;
  const times: number[] = [];
  const shop = shopAt(timers, settings);
  if (shop !== null) times.push(timers.shop.warned?.offAt ?? (lead && switchable(timers, settings).length ? shop - lead : shop));
  for (const entry of Object.values(timers.entries)) {
    const rule = ruleOf(entry, timers, settings);
    if (!rule) continue;
    if (entry.warned) times.push(entry.warned.offAt);
    else times.push(rule.action === "off" && entry.power && lead ? rule.at - lead : rule.at);
  }
  return times.length ? Math.max(Math.min(...times), now + MIN_WAKE_MS) : null;
}

/** When each resource is due to be switched off, in ms, for the board. One a rule only marks has none. */
export function idleScheduleOf(timers: IdleTimers, settings: IdleSettings, now: number): Record<string, number> {
  const schedule: Record<string, number> = {};
  const shop = shopAt(timers, settings);
  const byShop = shop === null ? null : timers.shop.warned?.offAt ?? shop;
  const shopKeys = new Set(shop === null ? [] : switchable(timers, settings));
  for (const [key, entry] of Object.entries(timers.entries)) {
    if (!entry.power) continue;
    const rule = ruleOf(entry, timers, settings);
    const at = shopKeys.has(key) ? byShop : rule?.action === "off" ? entry.warned?.offAt ?? rule.at : null;
    if (at === null || at <= now) continue;
    for (const id of entry.ids) schedule[id] = at;
  }
  return schedule;
}
