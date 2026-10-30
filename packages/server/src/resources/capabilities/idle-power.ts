/**
 * Idle power-off: when a shop or a device has been idle long enough, and what
 * to do about it. This module decides; the shop hub reads the inputs, acts on
 * the plan and wakes for the next deadline.
 *
 * Two rules, both off until the shop turns them on:
 * - **Shop empty**: no active entry for N minutes, then every free powered device
 *   and air conditioner is switched off, respecting occupancy and holds.
 * - **Device idle**: a powered device free for the shop's idle time. Climate
 *   follows the whole shop's devices, never the time since an AC setting. While
 *   the shop has players the owner chooses what happens: only
 *   mark it idle or switch it off, with an optional advance warning by the bot.
 *
 * A device is busy while someone occupies it (see `occupancy/`). Being switched
 * on, kept from idling, or operated through the platform keeps it busy for its
 * occupancy time too, so a guest game or a machine switched on outside the
 * platform is not cut short. Once nothing keeps it busy it is free, and after
 * the idle time free it is idle. A device is never switched off while occupied.
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
        /** How long a device stays free before it counts as idle. */
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

/** An automatic power-off that failed is not retried sooner than this. */
export const RETRY_OFF_MS = 10 * 60_000;

export type IdleDevice = {
  id: string;
  name: string;
  hasPower: boolean;
  hasClimate: boolean;
  /** Can be used without a power binding, for example an IO cabinet or held seats. */
  hasUsage: boolean;
  /** The physical HA binding; unshared when a legacy binding has no connection id. */
  powerTarget: string | null;
  climateTarget: string | null;
  /** Current power; null when nothing watches the device, or its source reports it unavailable. */
  power: "on" | "off" | null;
  /** Climate mode; anything other than "off" is running. Null when unknown. */
  climate: string | null;
  /** How long a sign of someone (switching on, a hold) keeps it busy: its occupancy time, or 0 where seats decide. */
  minutes: number;
  /** Latest sign of someone at it (an occupant seen, a hold), in ms. */
  lastActivity: number | null;
  /**
   * Until when its occupants keep it busy, in ms: the latest expiry among them,
   * or Infinity while one has no expiry (a seat). Null when nobody occupies it.
   */
  busyUntil: number | null;
  /** When it was last seen switching on, in ms. */
  poweredOnAt: number | null;
  idle: boolean;
  lastAutoOff: number | null;
  lastClimateAutoOff: number | null;
};

/** Unknown HA modes must not look like an air conditioner switching on. */
export function climatePower(state: string | null): "on" | "off" | null {
  return !state || state === "unknown" || state === "unavailable" ? null : state === "off" ? "off" : "on";
}

/** One physical actuator, with every resource that would be affected by switching it off. */
export function idleGroups(devices: IdleDevice[]) {
  const groups = new Map<string, { capability: "power" | "climate"; devices: IdleDevice[] }>();
  for (const device of devices) for (const capability of ["power", "climate"] as const) {
    if (!(capability === "power" ? device.hasPower : device.hasClimate)) continue;
    const target = capability === "power" ? device.powerTarget : device.climateTarget;
    const key = JSON.stringify([capability, target ?? device.id]);
    const group = groups.get(key) ?? { capability, devices: [] };
    group.devices.push(device);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type IdleInputs = {
  now: number;
  settings: IdleSettings;
  activeEntries: number;
  /** When the shop became empty, as remembered, or the last entry's end. */
  emptySince: number | null;
  /** The empty period whose power-off already ran. */
  emptyHandled: number | null;
  devices: IdleDevice[];
  /** How long before a power-off the bot should be told; null without a bot. */
  reminderLeadMs: number | null;
  /** Deadlines already reminded about, by key. */
  reminded: Record<string, number>;
};

export type Reminder = { key: string; reason: "shop_empty" | "device_idle"; deviceIds: string[]; at: number };

export type IdlePlan = {
  powerOff: string[];
  climateOff: string[];
  markIdle: string[];
  clearIdle: string[];
  remind: Reminder[];
  emptySince: number | null;
  emptyHandled: number | null;
  nextWake: number | null;
  /**
   * When each device is due to be switched off, in ms, once its countdown has
   * started: the shop is empty, or the device is free and the rule switches it
   * off. A device that is only marked idle has none.
   */
  powerOffAt: Record<string, number>;
};

export function planIdle(input: IdleInputs): IdlePlan {
  const { now, settings } = input;
  const plan: IdlePlan = {
    powerOff: [],
    climateOff: [],
    markIdle: [],
    clearIdle: [],
    remind: [],
    emptySince: null,
    emptyHandled: null,
    nextWake: null,
    powerOffAt: {},
  };
  const wake = (at: number) => {
    if (Number.isFinite(at) && at > now && (plan.nextWake === null || at < plan.nextWake)) plan.nextWake = at;
  };
  const remindBefore = (key: string, reason: Reminder["reason"], deviceIds: string[], deadline: number) => {
    if (input.reminderLeadMs === null || !deviceIds.length) return;
    const at = deadline - input.reminderLeadMs;
    if (now >= at && now < deadline && input.reminded[key] !== deadline) plan.remind.push({ key, reason, deviceIds, at: deadline });
    else if (now < at) wake(at);
  };
  const freeAt = (device: IdleDevice, changedAt = 0, on = false) => Math.max(
    (Math.max(device.lastActivity ?? 0, changedAt) || (on ? now : 0)) + device.minutes * 60_000,
    device.busyUntil ?? 0,
  );
  const idleMs = settings.device.minutes * 60_000;
  const groups = idleGroups(input.devices).map((group) => {
    const power = group.devices.map((d) => group.capability === "power" ? d.power : climatePower(d.climate));
    const changedAt = Math.max(...group.devices.map((d) => group.capability === "power" ? d.poweredOnAt ?? 0 : 0));
    const activity = Math.max(...group.devices.map((d) => d.lastActivity ?? 0));
    const attempted = Math.max(...group.devices.map((d) => (group.capability === "power" ? d.lastAutoOff : d.lastClimateAutoOff) ?? 0));
    const state = power.includes("on") ? "on" : power.every((state) => state === "off") ? "off" : null;
    return {
      ...group,
      ids: group.devices.map((d) => d.id),
      state,
      excluded: group.devices.some((d) => settings.devices[d.id]?.exclude),
      free: Math.max(...group.devices.map((d) => freeAt(d, changedAt, group.capability === "power" && state === "on"))),
      activity, attempted,
      canRetry: !attempted || now - attempted >= RETRY_OFF_MS,
    };
  });
  // Climate serves the shop; only other devices' usage decides when it is idle.
  // Unknown power without any activity cannot prove that a cabinet is idle.
  const deviceDeadlines = [
    ...groups.filter((group) => group.capability === "power").map((group) => group.state === "off" ? 0
      : group.state === null && !group.activity ? Infinity : group.free + idleMs),
    ...input.devices.filter((device) => device.hasUsage && !device.hasPower).map((device) => freeAt(device) + idleMs),
  ];
  const allDevicesIdleAt = deviceDeadlines.length ? Math.max(...deviceDeadlines) : Infinity;
  const turnOff = (group: typeof groups[number]) => {
    (group.capability === "power" ? plan.powerOff : plan.climateOff).push(...group.ids);
  };
  const countdown = (group: typeof groups[number], deadline: number) => {
    for (const id of group.ids) plan.powerOffAt[id] = Math.min(plan.powerOffAt[id] ?? Infinity, deadline);
  };
  const empty = input.activeEntries === 0;
  if (settings.shopEmpty.enabled && empty) {
    const since = input.emptySince ?? now;
    plan.emptySince = since;
    plan.emptyHandled = input.emptyHandled;
    if (input.emptyHandled !== since) {
      let pending = false;
      const warnings = new Map<number, string[]>();
      for (const group of groups) {
        if (group.excluded || group.state === "off") continue;
        // An occupied or recently used shared supply must not be cut by the shop rule either.
        const deadline = Math.max(since + settings.shopEmpty.minutes * 60_000, group.free);
        if (now < deadline) {
          pending = true;
          wake(deadline);
          if (Number.isFinite(deadline)) {
            countdown(group, deadline);
            warnings.set(deadline, [...(warnings.get(deadline) ?? []), ...group.ids]);
          }
        } else if (group.canRetry) turnOff(group);
        else { pending = true; wake(group.attempted + RETRY_OFF_MS); }
      }
      for (const [deadline, ids] of warnings) {
        const deferred = deadline !== since + settings.shopEmpty.minutes * 60_000;
        remindBefore(deferred ? `empty:${since}:${deadline}` : `empty:${since}`, deferred ? "device_idle" : "shop_empty", [...new Set(ids)], deadline);
      }
      if (!pending) plan.emptyHandled = since;
    }
  } else if (empty) {
    plan.emptySince = input.emptySince ?? now;
  }

  for (const group of groups) {
    // Without a known state the device's own activity is the only clock, and it
    // is switched off once per stretch of idleness: nothing shows whether it took.
    const blind = group.state === null;
    const handled = blind && group.attempted > 0 && group.attempted >= group.activity;
    if (group.excluded || group.state === "off" || !settings.device.enabled || (group.capability === "power" && blind && (!group.activity || handled))) {
      plan.clearIdle.push(...group.devices.filter((d) => d.idle).map((d) => d.id));
      continue;
    }
    // Never idle while occupied: an occupant without an expiry holds it indefinitely.
    if (group.free === Infinity || (group.capability === "climate" && !empty && allDevicesIdleAt === Infinity)) {
      plan.clearIdle.push(...group.devices.filter((d) => d.idle).map((d) => d.id));
      continue;
    }
    // Free once nothing keeps it busy; idle after the idle time free.
    const deadline = group.capability === "power" ? group.free + idleMs
      : Math.max(group.free, empty ? (plan.emptySince ?? now) + idleMs : allDevicesIdleAt);
    if (group.capability === "climate" && blind && group.attempted > 0 && group.attempted >= deadline) continue;
    const switchesOff = empty ? !settings.shopEmpty.enabled : settings.device.whileOccupied === "off";
    if (now < deadline) {
      plan.clearIdle.push(...group.devices.filter((d) => d.idle).map((d) => d.id));
      wake(deadline);
      // Counting down once nothing keeps it busy, where the rule would switch it off.
      if (now >= group.free && switchesOff) countdown(group, deadline);
      if (switchesOff)
        remindBefore(`${group.capability === "power" ? "device" : "climate"}:${group.ids[0]}`, "device_idle", group.ids, deadline);
      continue;
    }
    if ((group.capability === "power" ? plan.powerOff : plan.climateOff).includes(group.ids[0]!)) continue;
    // With nobody in, the device rule switches off unless the shop rule is
    // about to; with players in, the owner's choice applies.
    plan.markIdle.push(...group.devices.filter((d) => !d.idle).map((d) => d.id));
    if (switchesOff && group.canRetry) turnOff(group);
    if (switchesOff && !group.canRetry) wake(group.attempted + RETRY_OFF_MS);
  }
  plan.clearIdle = [...new Set(plan.clearIdle)];
  plan.markIdle = [...new Set(plan.markIdle)].filter((id) => !plan.clearIdle.includes(id));
  return plan;
}
