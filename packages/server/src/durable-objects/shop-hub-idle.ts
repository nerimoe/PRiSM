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
 * Actions that hold a device off idling for its occupancy time: someone asked
 * the platform to use it (switch it on, keep it, coin, swipe). Switching it off
 * does not. Who occupies it comes from occupancy, not from here.
 */
const HOLD_ACTIONS = Object.values(capabilities)
  .flatMap((spec) => Object.entries(spec.actions))
  .filter(([name, spec]) => spec?.countsAsPlay && name !== "power.off")
  .map(([name]) => name);
/** Only recent activity can matter; idle times are at most a day. */
const LOOKBACK_MS = 24 * 60 * 60_000;

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
  const anyRule = settings.shopEmpty.enabled || settings.device.enabled;
  if (!anyRule) return { memory: { ...emptyIdleMemory(), lastAutoOff: input.memory.lastAutoOff }, notices: [], poweredOff: [] };

  const [visits, capabilityRows, idleRows, activityRows, occupancy] = await Promise.all([
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM sessions WHERE shop_id = ? AND status = 'active') AS active,
              (SELECT MAX(ended_at) FROM sessions WHERE shop_id = ? AND status = 'closed') AS last_end`,
    ).bind(shopId, shopId).first<{ active: number; last_end: string | null }>(),
    db.prepare(
      // Where a capability holds its occupants itself (seats), they are the whole
      // story and the occupancy minutes do not apply, also not to activity.
      `SELECT m.id, m.name, c.capability, c.config_json,
              CASE WHEN EXISTS (SELECT 1 FROM device_capabilities h WHERE h.shop_id = m.shop_id AND h.device_id = m.id
                                  AND h.capability IN (SELECT value FROM json_each(?)))
                   THEN 0 ELSE m.occupancy_minutes END AS occupancy_minutes
       FROM machines m
       JOIN device_capabilities c ON c.shop_id = m.shop_id AND c.device_id = m.id
       WHERE m.shop_id = ? AND m.enabled = 1 AND c.capability IN ('power', 'climate')`,
    ).bind(JSON.stringify(heldProviders.map((provider) => provider.capability)), shopId)
      .all<{ id: string; name: string; occupancy_minutes: number; capability: "power" | "climate"; config_json: string }>(),
    // Whether the idle rule already marked a device idle is the rule's own record, not Home Assistant state.
    db.prepare(
      "SELECT device_id, value_json FROM device_state WHERE shop_id = ? AND capability = 'power' AND key = 'idle'",
    ).bind(shopId).all<{ device_id: string; value_json: string }>(),
    db.prepare(
      `SELECT device_id, MAX(occurred_at) AS at FROM device_events
       WHERE shop_id = ? AND occurred_at >= ?
         AND kind = 'request' AND name IN (SELECT value FROM json_each(?)) AND (player_id IS NOT NULL OR staff_id IS NOT NULL)
       GROUP BY device_id`,
    ).bind(shopId, new Date(now - LOOKBACK_MS).toISOString(), JSON.stringify(HOLD_ACTIONS))
      .all<{ device_id: string; at: string }>(),
    createOccupancy({ db, shopId, now: () => new Date(now) }).current(),
  ]);

  const devices = new Map<string, IdleDevice>();
  const device = (id: string, name: string, minutes: number) => {
    let entry = devices.get(id);
    if (!entry) {
      entry = {
        id, name, minutes, hasPower: false, hasClimate: false, power: null, climate: null,
        lastActivity: null, busyUntil: null, poweredOnAt: null, idle: false, lastAutoOff: input.memory.lastAutoOff[id] ?? null,
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
    const entry = device(row.id, row.name, row.occupancy_minutes);
    if (row.capability === "power") entry.hasPower = true;
    else entry.hasClimate = true;
    const target = bound.get(row.id) ?? { id: row.id, capabilities: new Map() };
    target.capabilities.set(row.capability, { config: (parse(row.config_json) as Record<string, unknown> | null) ?? {} });
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
  for (const row of idleRows.results) {
    const entry = devices.get(row.device_id);
    if (entry) entry.idle = parse(row.value_json) === true;
  }
  for (const row of activityRows.results) {
    const entry = devices.get(row.device_id);
    if (entry) entry.lastActivity = Date.parse(row.at);
  }
  for (const resource of occupancy) {
    const entry = devices.get(resource.resourceId);
    if (!entry || !resource.occupants.length) continue;
    entry.busyUntil = resource.occupants.some((occupant) => occupant.expiresAt === null)
      ? Infinity
      : Math.max(...resource.occupants.map((occupant) => occupant.expiresAt!.getTime()));
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
  for (const id of plan.powerOff) {
    memory.lastAutoOff[id] = now;
    if (await act(id, "power.off")) poweredOff.push(id);
  }
  for (const id of plan.climateOff) await act(id, "climate.off");
  for (const [ids, value] of [[plan.markIdle, true], [plan.clearIdle, false]] as const) {
    for (const id of ids) {
      await bus.setOwned({ device: { id }, capability: "power", key: "idle", value }).catch((error) =>
        console.error("Idle mark failed", { shopId, id, error }));
    }
  }
  const notices = plan.remind.map((reminder) => {
    memory.reminded[reminder.key] = reminder.at;
    return {
      reason: reminder.reason,
      at: reminder.at,
      devices: reminder.deviceIds.map((id) => ({ id, name: devices.get(id)?.name ?? id })),
    };
  });
  if (plan.powerOff.length) {
    // Check again once the retry window has passed, in case one did not take.
    const retry = now + 10 * 60_000;
    memory.wakeAt = memory.wakeAt === null ? retry : Math.min(memory.wakeAt, retry);
  }
  return { memory, notices, poweredOff };
}
