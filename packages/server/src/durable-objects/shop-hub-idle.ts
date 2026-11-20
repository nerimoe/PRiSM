/**
 * What the shop hub's idle timers (`resources/capabilities/idle-power.ts`)
 * need from the shop: which switch a resource is on, whether a bill is open,
 * which seats are taken, and the power-off itself, made through the device bus
 * as the system.
 *
 * None of it is read on a schedule. A signal names a resource and the hub
 * looks up its switch; the rest is read when the event it belongs to arrives
 * (a bill closing, a seat changing, the rules being edited).
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import { loadResource } from "../resources/resource.js";
import { IDLE_SETTINGS_KEY, parseIdleSettings, type IdleReason, type IdleSettings } from "../resources/capabilities/idle-power.js";
import { readShopLiveStates } from "../resources/capabilities/device-state.js";
import { createRuntimeBus } from "../resources/capabilities/runtime.js";
import type { HubCalls } from "./shop-hub-client.js";
import { heldProviders } from "../resources/occupancy/providers.js";

/** A warning for the bot, with device names so it can be said as is. */
export type IdleNotice = { reason: IdleReason; at: number; devices: Array<{ id: string; name: string }> };

/** The switch a resource is on: its key among the timers, and every resource on it. */
export type IdleGroup = { key: string; ids: string[]; power: boolean };

const parse = (value: string | null) => {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};

export async function loadIdleSettings(db: D1DatabaseLike, shopId: string): Promise<IdleSettings> {
  const row = await db.prepare("SELECT value_json FROM app_settings WHERE shop_id = ? AND key = ?")
    .bind(shopId, IDLE_SETTINGS_KEY).first<{ value_json: string }>();
  return parseIdleSettings(parse(row?.value_json ?? null));
}

type BindingRow = { id: string; name: string; occupancy_minutes: number | null; capability: string | null; config_json: string | null };

/** The Home Assistant entity a capability is bound to, as one string; null when it is not fully bound. */
const bindingOf = (config: Record<string, unknown>) =>
  typeof config.connectionId === "string" && typeof config.entityId === "string"
    ? JSON.stringify([config.connectionId, config.entityId]) : null;

async function bindings(db: D1DatabaseLike, shopId: string, capability: "power" | "climate") {
  const rows = await db.prepare(
    `SELECT m.id, m.name, m.occupancy_minutes, c.capability, c.config_json
     FROM machines m
     LEFT JOIN device_capabilities c ON c.shop_id = m.shop_id AND c.device_id = m.id AND c.capability = ?
     WHERE m.shop_id = ? AND m.enabled = 1 ORDER BY m.id`,
  ).bind(capability, shopId).all<BindingRow>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    stayMs: (row.occupancy_minutes ?? 0) * 60_000,
    bound: row.capability !== null,
    config: (parse(row.config_json) as Record<string, unknown> | null) ?? {},
  }));
}

/**
 * Every enabled resource's switch. Resources bound to the same Home Assistant
 * entity share one: a coin at any of them keeps all of them on. A resource
 * without a power binding is its own, with nothing to switch.
 */
export async function idleGroups(db: D1DatabaseLike, shopId: string): Promise<{
  groups: Map<string, IdleGroup>;
  names: Map<string, string>;
  /** How long a player's stay on each resource lasts once seen, in ms. */
  stays: Map<string, number>;
}> {
  const rows = await bindings(db, shopId, "power");
  const byKey = new Map<string, IdleGroup>();
  const groups = new Map<string, IdleGroup>();
  for (const row of rows) {
    const target = row.bound ? bindingOf(row.config) : null;
    const key = target ? `power:${target}` : `device:${row.id}`;
    const group = byKey.get(key) ?? { key, ids: [], power: row.bound };
    group.ids.push(row.id);
    byKey.set(key, group);
    groups.set(row.id, group);
  }
  return { groups, names: new Map(rows.map((row) => [row.id, row.name])), stays: new Map(rows.map((row) => [row.id, row.stayMs])) };
}

/** Whether no bill is open at the shop. */
export async function shopIsEmpty(db: D1DatabaseLike, shopId: string): Promise<boolean> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE shop_id = ? AND status = 'active'")
    .bind(shopId).first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** The resources whose seats are taken. */
export async function heldResources(db: D1DatabaseLike, shopId: string): Promise<Set<string>> {
  const held = await Promise.all(heldProviders.map((provider) => provider.held!(db, shopId)));
  return new Set(held.flat().map((occupant) => occupant.resourceId));
}

/**
 * The devices Home Assistant currently reports switched on, and since when.
 * Read once when the timers are started over (the rules were edited, or the
 * hub has none yet); after that the watcher's reports say it.
 */
export async function devicesSeenOn(
  db: D1DatabaseLike,
  shopId: string,
  liveConnections: ReadonlySet<string>,
): Promise<Array<{ id: string; at: number | null }>> {
  const bound = (await bindings(db, shopId, "power")).filter((row) => row.bound)
    .map((row) => ({ id: row.id, capabilities: new Map([["power", { config: row.config }]]) }));
  const live = await readShopLiveStates(db, shopId, bound as never, { liveConnections });
  return Object.entries(live.states)
    .filter(([, state]) => state.watching && state.power === "on")
    .map(([id]) => ({ id, at: live.powerChangedAt[id] ?? null }));
}

/** One resource per air conditioner that is not known to be off, leaving out the excluded. */
export async function climatesToSwitchOff(db: D1DatabaseLike, shopId: string, settings: IdleSettings): Promise<string[]> {
  const rows = (await bindings(db, shopId, "climate")).filter((row) => row.bound && !settings.devices[row.id]?.exclude);
  if (!rows.length) return [];
  const stored = await db.prepare(
    "SELECT device_id, value_json FROM device_state WHERE shop_id = ? AND capability = 'climate' AND key = 'climate'",
  ).bind(shopId).all<{ device_id: string; value_json: string }>();
  const mode = new Map(stored.results.map((row) => [row.device_id, (parse(row.value_json) as { mode?: unknown } | null)?.mode]));
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (mode.get(row.id) === "off") return false;
    const target = bindingOf(row.config) ?? row.id;
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  }).map((row) => row.id);
}

/**
 * Switch a resource off as the system. True when the hardware took it. What
 * follows from it (the bots told, the watch released) is the listeners', who
 * reach `hub` directly.
 */
export async function switchOff(env: Env, shopId: string, id: string, action: "power.off" | "climate.off", hub: HubCalls): Promise<boolean> {
  const target = await loadResource(env.DB, shopId, id);
  if (!target) return false;
  const bus = createRuntimeBus({ db: env.DB, env, shopId, hub, via: { channel: "system", resourceId: null } });
  try {
    return (await bus.perform({ device: target, action, actor: { type: "system" } })).operation.status === "succeeded";
  } catch (error) {
    console.error("Idle power-off failed", { shopId, id, action, error });
    return false;
  }
}
