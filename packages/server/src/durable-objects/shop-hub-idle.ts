/**
 * The shop hub's idle check: read what `planIdle` needs from storage and the
 * watched states, then carry the plan out through the device bus as the system.
 */
import type { Env } from "../bindings.js";
import { capabilities } from "../resources/capabilities/catalog.js";
import { loadResource } from "../resources/resource.js";
import {
  IDLE_SETTINGS_KEY,
  parseIdleSettings,
  planIdle,
  idleGroups,
  type IdleDevice,
  type Reminder,
} from "../resources/capabilities/idle-power.js";
import { readShopLiveStates } from "../resources/capabilities/device-state.js";
import { createRuntimeBus } from "../resources/capabilities/runtime.js";
import { heldProviders } from "../resources/occupancy/providers.js";
import { createOccupancy } from "../resources/occupancy/service.js";

/** What the hub remembers between checks. */
export type IdleMemory = {
  emptySince: number | null;
  emptyHandled: number | null;
  reminded: Record<string, number>;
  lastAutoOff: Record<string, number>;
  wakeAt: number | null;
  /** When the last check expected each device to be switched off; see `IdlePlan.powerOffAt`. */
  powerOffAt?: Record<string, number>;
};

export const emptyIdleMemory = (): IdleMemory => ({ emptySince: null, emptyHandled: null, reminded: {}, lastAutoOff: {}, wakeAt: null, powerOffAt: {} });

/** A reminder for the bot, with device names so it can be shown as is. */
export type IdleNotice = Omit<Reminder, "deviceIds" | "key"> & { devices: Array<{ id: string; name: string }> };

/**
 * Platform activity resets the shutdown wait; occupancy supplies its own expiry.
 * Switching a device off does not extend either.
 */
const HOLD_ACTIONS = Object.values(capabilities)
  .flatMap((spec) => Object.entries(spec.actions))
  .filter(([name, spec]) => spec?.countsAsPlay && name !== "power.off")
  .map(([name]) => name);
/** Only recent activity can matter; idle times are at most a day. */
const LOOKBACK_MS = 24 * 60 * 60_000;
const IDLE_CAPABILITIES = Object.values(capabilities).filter((spec) =>
  spec.id === "climate" || Object.values(spec.actions).some((action) => action?.countsAsPlay)
  || heldProviders.some((provider) => provider.capability === spec.id),
).map((spec) => spec.id);

const parse = (value: string | null) => {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};

export async function runIdleCheck(input: {
  env: Env;
  shopId: string;
  now: number;
  memory: IdleMemory;
  /** Home Assistant connections whose stored state is current; for the others a device's power is unknown. */
  eventConnections: ReadonlySet<string>;
  reminderLeadMs: number | null;
}): Promise<{ memory: IdleMemory; notices: IdleNotice[]; poweredOff: string[] }> {
  const { env, shopId, now } = input;
  const db = env.DB;
  const settings = parseIdleSettings(
    parse(
      (await db.prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?").bind(shopId, IDLE_SETTINGS_KEY)
        .first<{ value_json: string }>())?.value_json ?? null,
    ),
  );
  if (!settings.shopEmpty.enabled && !settings.device.enabled)
    return { memory: { ...emptyIdleMemory(), lastAutoOff: input.memory.lastAutoOff }, notices: [], poweredOff: [] };
  // Settle held seats before reading their last usage, including seats just vacated.
  const occupancy = await createOccupancy({ db, shopId, now: () => new Date(now) }).current();
  const [visits, capabilityRows, activityRows] = await Promise.all([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM sessions WHERE shop_id = ? AND status = 'active') AS active,
              (SELECT MAX(ended_at) FROM sessions WHERE shop_id = ? AND status = 'closed') AS last_end`,
    ).bind(shopId, shopId).first<{ active: number; last_end: string | null }>(),
    db.prepare(
      `SELECT m.id, m.name, c.capability, c.config_json
       FROM machines m
       JOIN device_capabilities c ON c.shop_id = m.shop_id AND c.device_id = m.id
       WHERE m.shop_id = ? AND m.enabled = 1 AND c.capability IN (SELECT value FROM json_each(?)) ORDER BY m.id, c.capability`,
    ).bind(shopId, JSON.stringify(IDLE_CAPABILITIES))
      .all<{ id: string; name: string; capability: string; config_json: string }>(),
    db.prepare(
      `SELECT device_id, MAX(at) AS at, MAX(occupied_until) AS occupied_until FROM (
         SELECT device_id, occurred_at AS at, NULL AS occupied_until FROM device_events
         WHERE shop_id = ? AND occurred_at >= ?
           AND kind = 'request' AND name IN (SELECT value FROM json_each(?)) AND (player_id IS NOT NULL OR staff_id IS NOT NULL)
         UNION ALL
         SELECT resource_id, last_seen_at, COALESCE(ended_at, expires_at) FROM resource_occupancies
         WHERE shop_id = ? AND COALESCE(ended_at, expires_at, last_seen_at) >= ? AND (ended_at IS NOT NULL OR expires_at <= ?)
       ) GROUP BY device_id`,
    ).bind(shopId, new Date(now - LOOKBACK_MS).toISOString(), JSON.stringify(HOLD_ACTIONS),
      shopId, new Date(now - LOOKBACK_MS).toISOString(), new Date(now).toISOString())
      .all<{ device_id: string; at: string; occupied_until: string | null }>(),
  ]);

  const devices = new Map<string, IdleDevice>();
  const device = (id: string, name: string) => {
    let entry = devices.get(id);
    if (!entry) {
      entry = {
        id, name, hasPower: false, hasClimate: false, hasUsage: false, power: null, climate: null,
        powerTarget: null, climateTarget: null,
        lastActivity: null, busyUntil: null, poweredOnAt: null, lastAutoOff: input.memory.lastAutoOff[id] ?? null,
        lastClimateAutoOff: input.memory.lastAutoOff[`climate:${id}`] ?? null,
      };
      devices.set(id, entry);
    }
    return entry;
  };
  // Power and climate are known only for a live device, judged as every other
  // reader judges it; elsewhere they are unknown, and the idle rules switch off
  // without knowing.
  const bound = new Map<string, { id: string; capabilities: Map<string, { config: Record<string, unknown> }> }>();
  for (const row of capabilityRows.results) {
    const entry = device(row.id, row.name);
    if (row.capability !== "power" && row.capability !== "climate") { entry.hasUsage = true; continue; }
    if (row.capability === "power") entry.hasPower = true;
    else entry.hasClimate = true;
    const target = bound.get(row.id) ?? { id: row.id, capabilities: new Map() };
    const config = (parse(row.config_json) as Record<string, unknown> | null) ?? {};
    target.capabilities.set(row.capability, { config });
    const binding = typeof config.connectionId === "string" && typeof config.entityId === "string"
      ? JSON.stringify([config.connectionId, config.entityId]) : null;
    if (row.capability === "power") entry.powerTarget = binding;
    else entry.climateTarget = binding;
    bound.set(row.id, target);
  }
  const live = await readShopLiveStates(db, shopId, [...bound.values()], { liveConnections: input.eventConnections });
  for (const [id, state] of Object.entries(live.states)) {
    const entry = devices.get(id);
    if (!entry || !state.watching) continue;
    if (entry.hasPower) {
      entry.power = state.power;
      if (state.power === "on") entry.poweredOnAt = live.powerChangedAt[id] ?? null;
    }
    if (entry.hasClimate && state.climate) entry.climate = state.climate.mode;
  }
  for (const row of activityRows.results) {
    const entry = devices.get(row.device_id);
    if (entry) {
      entry.lastActivity = Date.parse(row.at);
      if (row.occupied_until) entry.busyUntil = Date.parse(row.occupied_until);
    }
  }
  for (const resource of occupancy) {
    const entry = devices.get(resource.resourceId);
    if (!entry || !resource.occupants.length) continue;
    entry.busyUntil = resource.occupants.some((occupant) => occupant.expiresAt === null)
      ? Infinity
      : Math.max(entry.busyUntil ?? 0, ...resource.occupants.map((occupant) => occupant.expiresAt!.getTime()));
    entry.lastActivity = Math.max(entry.lastActivity ?? 0, ...resource.occupants.map((occupant) => occupant.lastSeenAt.getTime()));
  }

  const lastEnd = visits?.last_end ? Date.parse(visits.last_end) : null;
  const active = visits?.active ?? 0;
  const plan = planIdle({
    now,
    settings,
    activeEntries: active,
    emptySince: active === 0 ? (input.memory.emptySince ?? lastEnd ?? now) : null,
    emptyHandled: input.memory.emptyHandled,
    devices: [...devices.values()],
    reminderLeadMs: input.reminderLeadMs,
    reminded: input.memory.reminded,
  });

  // The hub is told about an IO this switches off itself, so it does not call back into its own object.
  const bus = createRuntimeBus({ db, env, shopId, notifyHub: false });
  const memory: IdleMemory = {
    emptySince: plan.emptySince,
    emptyHandled: plan.emptyHandled,
    reminded: Object.fromEntries(Object.entries(input.memory.reminded).filter(([, at]) => at > now)),
    lastAutoOff: { ...input.memory.lastAutoOff },
    wakeAt: plan.nextWake,
    powerOffAt: plan.powerOffAt,
  };
  const act = async (id: string, action: "power.off" | "climate.off") => {
    const target = await loadResource(db, shopId, id);
    if (!target) return false;
    try {
      return (await bus.perform({ device: target, action, actor: { type: "system" } })).operation.status === "succeeded";
    } catch (error) {
      console.error("Idle power-off failed", { shopId, id, action, error });
      return false;
    }
  };
  const poweredOff: string[] = [];
  for (const group of idleGroups([...devices.values()])) {
    const planned = group.capability === "power" ? plan.powerOff : plan.climateOff;
    if (!group.devices.some((device) => planned.includes(device.id))) continue;
    for (const device of group.devices) memory.lastAutoOff[group.capability === "power" ? device.id : `climate:${device.id}`] = now;
    // Shared bindings get one command; its retry window applies to every member.
    if (await act(group.devices[0]!.id, group.capability === "power" ? "power.off" : "climate.off")) {
      if (group.capability === "power") poweredOff.push(...group.devices.map((device) => device.id));
    } else memory.emptyHandled = input.memory.emptyHandled;
  }
  const notices = plan.remind.map((reminder) => {
    memory.reminded[reminder.key] = reminder.at;
    return {
      reason: reminder.reason,
      at: reminder.at,
      devices: reminder.deviceIds.map((id) => ({ id, name: devices.get(id)?.name ?? id })),
    };
  });
  if (plan.powerOff.length || plan.climateOff.length) {
    // Check again once the retry window has passed, in case one did not take.
    const retry = now + 10 * 60_000;
    memory.wakeAt = memory.wakeAt === null ? retry : Math.min(memory.wakeAt, retry);
  }
  return { memory, notices, poweredOff };
}
