/**
 * The one place a device's power and air conditioner are read.
 *
 * A Home Assistant connection is in one of two modes. While a watcher (a shop
 * bot or a HINATA IO) has it subscribed (`ha_event_connections` has a row) every
 * change arrives as an event and `device_state` is current: the connection is
 * *live*, and readers take the stored value without asking Home Assistant.
 * Otherwise nothing is known and a reader that needs the state asks Home
 * Assistant itself, recording nothing. Only the shop hub moves a connection
 * between the two, after the full state of a new watcher is stored, so a row
 * there is never ahead of the data it vouches for.
 *
 * Liveness belongs to a connection; a device is live when every connection its
 * power and climate use is live. A binding from before shop connections has no
 * connection and is never live.
 *
 * Two kinds of reader; outside the shop hub, which writes both tables, nothing
 * else reads `device_state` or `ha_event_connections` for power or climate:
 * - `readDeviceState`, `readShopDeviceStates`, `readPower`, `readClimate`: the
 *   answer. A live device answers from storage; any other is asked of Home
 *   Assistant now.
 * - `readLiveState`, `readShopLiveStates`: storage only, for code that must not
 *   reach Home Assistant (the idle check, the first read of a scanned page). A
 *   device that is not live is `unknownState`.
 *
 * Clients never choose between the two. They get a `DeviceView` (power and
 * climate only) from whichever channel carries it and show the latest one; the
 * backend decides where each value comes from, when Home Assistant is asked,
 * and pushes what it learns (see the shop hub and `readAfterAction`).
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { getHomeAssistantEntity, getHomeAssistantEntityState } from "../../hardware/home-assistant.js";
import { listResources, readSecret, type Resource } from "../resource.js";
import type { HaEntityConfig } from "./catalog.js";
import { openHaConnection } from "./ha-connections.js";
import type { DeviceRuntime } from "./runtime.js";

/** What a climate entity is doing and what it offers. */
export type ClimateState = {
  /** `off`, or the running HVAC mode such as `cool`, `heat`, `dry`, `fan_only`, `auto`. */
  mode: string;
  modes: string[];
  temperature: number | null;
  currentTemperature: number | null;
  minTemperature: number | null;
  maxTemperature: number | null;
  temperatureStep: number | null;
  fanMode: string | null;
  fanModes: string[];
};

const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A climate state from a Home Assistant state and its attributes. */
export function climateState(state: string, a: Record<string, unknown>): ClimateState {
  return {
    mode: state,
    modes: strings(a.hvac_modes),
    temperature: numberOrNull(a.temperature),
    currentTemperature: numberOrNull(a.current_temperature),
    minTemperature: numberOrNull(a.min_temp),
    maxTemperature: numberOrNull(a.max_temp),
    temperatureStep: numberOrNull(a.target_temp_step),
    fanMode: typeof a.fan_mode === "string" ? a.fan_mode : null,
    fanModes: strings(a.fan_modes),
  };
}

/**
 * The part of a climate state that is a setting. Room temperature drifts on
 * its own, so recording it would log a change on nearly every read.
 */
export const climateSetting = (state: ClimateState) => ({
  mode: state.mode,
  temperature: state.temperature,
  fanMode: state.fanMode,
});

/** Power and climate of one device. */
export type DeviceState = {
  /** The device is live: every connection it uses is watched, so the values are current. */
  watching: boolean;
  /** Null when the device has no power, it cannot be read, or Home Assistant reports it unavailable. */
  power: "on" | "off" | null;
  /** Null when the device has no climate, it cannot be read, or Home Assistant reports it unavailable. */
  climate: ClimateState | null;
};

export const unknownState: DeviceState = { watching: false, power: null, climate: null };

/** What liveness is judged from: a device's id and how its capabilities are bound. */
export type BoundDevice = { id: string; capabilities: ReadonlyMap<string, { config: Record<string, unknown> }> };

/**
 * The Home Assistant connections a device's power and climate use. A binding
 * from before connections existed has none and can never be live, which shows
 * up as an empty string.
 */
export function haConnectionsOf(device: Pick<BoundDevice, "capabilities">): string[] {
  const ids = new Set<string>();
  for (const id of ["power", "climate"] as const) {
    const bound = device.capabilities.get(id);
    if (!bound) continue;
    const connectionId = (bound.config as { connectionId?: unknown }).connectionId;
    ids.add(typeof connectionId === "string" && connectionId ? connectionId : "");
  }
  return [...ids];
}

const isLive = (connections: readonly string[], live: ReadonlySet<string>) =>
  connections.length > 0 && !connections.includes("") && connections.every((id) => live.has(id));

type Rows<T> = { results: T[] };
type StateRow = { capability: string; key: string; value_json: string; changed_at: string };

const STATE_KEYS = "((capability = 'power' AND key = 'power') OR (capability = 'climate' AND key = 'view'))";

/** A live device's state from its stored rows, and when its power last changed. */
function stateFrom(rows: readonly StateRow[]): { state: DeviceState; powerChangedAt: number | null } {
  const state: DeviceState = { watching: true, power: null, climate: null };
  let powerChangedAt: number | null = null;
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (row.capability === "power") {
      state.power = value === "on" || value === "off" ? value : null;
      powerChangedAt = Date.parse(row.changed_at);
    } else if (value && typeof value === "object") state.climate = value as ClimateState;
  }
  return { state, powerChangedAt };
}

/** One device from storage; `unknownState` unless it is live. */
export async function readLiveState(
  db: D1DatabaseLike,
  shopId: string,
  device: BoundDevice,
): Promise<DeviceState> {
  const connections = haConnectionsOf(device);
  if (!connections.length || connections.includes("")) return unknownState;
  const [watched, stored] = (await db.batch([
    db
      .prepare(
        `SELECT connection_id FROM ha_event_connections
         WHERE shop_id = ? AND connection_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(shopId, JSON.stringify(connections)),
    db
      .prepare(`SELECT capability, key, value_json, changed_at FROM device_state WHERE shop_id = ? AND device_id = ? AND ${STATE_KEYS}`)
      .bind(shopId, device.id),
  ])) as [Rows<{ connection_id: string }>, Rows<StateRow>];
  if (!isLive(connections, new Set(watched.results.map((row) => row.connection_id)))) return unknownState;
  return stateFrom(stored.results).state;
}

/** The shop's devices with power or an air conditioner, exactly as stored. */
export async function statefulDevices(db: D1DatabaseLike, shopId: string): Promise<Resource[]> {
  return (await listResources(db, shopId)).filter(
    (device) => device.capabilities.has("power") || device.capabilities.has("climate"),
  );
}

export type ShopStates = {
  states: Record<string, DeviceState>;
  /**
   * Which Home Assistant connections are live right now. One connection
   * dropping takes every device bound to it out of live mode at once, and
   * readers that care about the change should see it once.
   */
  liveConnections: string[];
};

/**
 * Every given device from storage, in at most two reads. `liveConnections`
 * is for the shop hub, which holds the set itself; everyone else reads it.
 * `powerChangedAt` has when each live device's power last changed.
 */
export async function readShopLiveStates(
  db: D1DatabaseLike,
  shopId: string,
  devices: readonly BoundDevice[],
  options: { liveConnections?: ReadonlySet<string> } = {},
): Promise<ShopStates & { powerChangedAt: Record<string, number> }> {
  const stored = db
    .prepare(`SELECT device_id, capability, key, value_json, changed_at FROM device_state WHERE shop_id = ? AND ${STATE_KEYS}`)
    .bind(shopId);
  let live: ReadonlySet<string>;
  let rows: Array<StateRow & { device_id: string }>;
  if (options.liveConnections) {
    live = options.liveConnections;
    rows = (await stored.all<StateRow & { device_id: string }>()).results;
  } else {
    const [watched, state] = (await db.batch([
      db.prepare("SELECT connection_id FROM ha_event_connections WHERE shop_id = ?").bind(shopId),
      stored,
    ])) as [Rows<{ connection_id: string }>, Rows<StateRow & { device_id: string }>];
    live = new Set(watched.results.map((row) => row.connection_id));
    rows = state.results;
  }
  const rowsByDevice = new Map<string, StateRow[]>();
  for (const row of rows) {
    const list = rowsByDevice.get(row.device_id) ?? [];
    list.push(row);
    rowsByDevice.set(row.device_id, list);
  }
  const states: Record<string, DeviceState> = {};
  const powerChangedAt: Record<string, number> = {};
  for (const device of devices) {
    if (!isLive(haConnectionsOf(device), live)) {
      states[device.id] = unknownState;
      continue;
    }
    const read = stateFrom(rowsByDevice.get(device.id) ?? []);
    states[device.id] = read.state;
    if (read.powerChangedAt !== null && Number.isFinite(read.powerChangedAt)) powerChangedAt[device.id] = read.powerChangedAt;
  }
  return { states, liveConnections: [...live], powerChangedAt };
}

type HaBinding = { url: string; token: string; entityId: string };

/** Where a device's power or climate lives in Home Assistant, with the token to reach it. */
export async function haBinding(
  runtime: DeviceRuntime,
  device: Resource,
  capability: "power" | "climate" = "power",
): Promise<HaBinding | null> {
  const config = device.capabilities.get(capability)?.config as HaEntityConfig | undefined;
  if (config?.connectionId && config.entityId) {
    const connection = await openHaConnection(runtime.db, device.shopId, config.connectionId, runtime.env.URL_ENCRYPTION_KEY);
    return connection ? { url: connection.url, token: connection.token, entityId: config.entityId } : null;
  }
  // A binding from before shop connections, not yet adopted.
  const raw = await readSecret(runtime.db, device, capability, "binding", runtime.env.URL_ENCRYPTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HaBinding>;
    return typeof parsed.url === "string" && typeof parsed.token === "string" && typeof parsed.entityId === "string"
      ? { url: parsed.url, token: parsed.token, entityId: parsed.entityId }
      : null;
  } catch {
    return null;
  }
}

async function askPower(runtime: DeviceRuntime, device: Resource): Promise<"on" | "off" | null> {
  const binding = await haBinding(runtime, device);
  if (!binding) return null;
  const state = await getHomeAssistantEntityState({
    baseUrl: binding.url,
    accessToken: binding.token,
    entityId: binding.entityId,
    fetch: runtime.fetcher,
    timeoutMs: 3000,
  });
  return state === "on" || state === "off" ? state : null;
}

async function askClimate(runtime: DeviceRuntime, device: Resource): Promise<ClimateState | null> {
  const binding = await haBinding(runtime, device, "climate");
  if (!binding) return null;
  const entity = await getHomeAssistantEntity({
    baseUrl: binding.url,
    accessToken: binding.token,
    entityId: binding.entityId,
    fetch: runtime.fetcher,
    timeoutMs: 3000,
  });
  if (!entity || entity.state === "unavailable" || entity.state === "unknown") return null;
  return climateState(entity.state, entity.attributes);
}

/** A device that is not live, asked of Home Assistant now, both at once. Nothing is recorded. */
async function askState(runtime: DeviceRuntime, device: Resource): Promise<DeviceState> {
  const [power, climate] = await Promise.all([
    device.capabilities.has("power") ? askPower(runtime, device).catch(() => null) : null,
    device.capabilities.has("climate") ? askClimate(runtime, device).catch(() => null) : null,
  ]);
  return { watching: false, power, climate };
}

/** Power and climate of a device: from storage while live, otherwise asked of Home Assistant now. */
export async function readDeviceState(runtime: DeviceRuntime, device: Resource): Promise<DeviceState> {
  const state = await readLiveState(runtime.db, runtime.shopId, device);
  return state.watching ? state : askState(runtime, device);
}

/** Power alone, the same way: "on", "off", or null when it cannot be read. */
export async function readPower(runtime: DeviceRuntime, device: Resource): Promise<"on" | "off" | null> {
  const state = await readLiveState(runtime.db, runtime.shopId, device);
  return state.watching ? state.power : askPower(runtime, device);
}

/** Climate alone, the same way; null when it cannot be read. */
export async function readClimate(runtime: DeviceRuntime, device: Resource): Promise<ClimateState | null> {
  const state = await readLiveState(runtime.db, runtime.shopId, device);
  return state.watching ? state.climate : askClimate(runtime, device);
}

/** How many devices that are not live are asked of Home Assistant at once. */
const ASK_CONCURRENCY = 4;

/**
 * Every given device (by default every one with power or an air conditioner),
 * the same way as `readDeviceState`: live ones from storage in two reads, the
 * others asked of Home Assistant a few at a time.
 */
export async function readShopDeviceStates(
  runtime: DeviceRuntime,
  devices?: readonly Resource[],
): Promise<ShopStates & { devices: Resource[] }> {
  const list = devices ? [...devices] : await statefulDevices(runtime.db, runtime.shopId);
  const { states, liveConnections } = await readShopLiveStates(runtime.db, runtime.shopId, list);
  const unknown = list.filter((device) => !states[device.id]!.watching);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ASK_CONCURRENCY, unknown.length) }, async () => {
    while (next < unknown.length) {
      const device = unknown[next++]!;
      states[device.id] = await askState(runtime, device);
    }
  }));
  return { devices: list, states, liveConnections };
}

/**
 * What a client is told of a device: its power and climate, each only when the
 * device has it. Whether the values came from storage or from Home Assistant is
 * not the client's business.
 */
export type DeviceView = { power?: "on" | "off" | null; climate?: ClimateState | null };

export function deviceView(device: Pick<BoundDevice, "capabilities">, state: DeviceState): DeviceView {
  return {
    ...(device.capabilities.has("power") ? { power: state.power } : {}),
    ...(device.capabilities.has("climate") ? { climate: state.climate } : {}),
  };
}

/** Whether a state shows that a power or climate action took effect; null for any other action. */
export function actionShown(action: string, payload: Record<string, unknown> = {}): ((state: DeviceState) => boolean) | null {
  switch (action) {
    case "power.on":
      return (state) => state.power === "on";
    case "power.off":
      return (state) => state.power === "off";
    case "climate.on":
      return (state) => !!state.climate && state.climate.mode !== "off";
    case "climate.off":
      return (state) => state.climate?.mode === "off";
    case "climate.set_mode":
      return (state) => state.climate?.mode === payload.mode;
    case "climate.set_temperature":
      return (state) => state.climate?.temperature === payload.temperature;
    case "climate.set_fan_mode":
      return (state) => state.climate?.fanMode === payload.fanMode;
    default:
      return null;
  }
}

/**
 * Home Assistant can answer a service call before its entity shows the change,
 * and a watcher's event takes a moment to be stored, so the state is read a few
 * times until it shows the action.
 */
const AFTER_ACTION_DELAYS_MS = [0, 400, 1200];

/**
 * The device's state after a power or climate action, read the same way as any
 * other read: from storage while live, otherwise from Home Assistant. Read again
 * a few times until it shows the action; the last read is the answer either way.
 * Null for an action that does not touch power or climate.
 */
export async function readAfterAction(
  runtime: DeviceRuntime,
  device: Resource,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<DeviceState | null> {
  const shown = actionShown(action, payload);
  if (!shown) return null;
  let state = unknownState;
  for (const delay of AFTER_ACTION_DELAYS_MS) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    state = await readDeviceState(runtime, device);
    if (shown(state)) break;
  }
  return state;
}

/** Move connections into or out of live mode, in one batch. Only the shop hub calls this. */
export async function writeEventConnections(
  db: D1DatabaseLike,
  shopId: string,
  change: { add: readonly string[]; remove: readonly string[] },
  now = new Date(),
): Promise<void> {
  const statements = [
    ...change.add.map((id) =>
      db
        .prepare(
          `INSERT INTO ha_event_connections (shop_id, connection_id, since) VALUES (?, ?, ?)
           ON CONFLICT(shop_id, connection_id) DO NOTHING`,
        )
        .bind(shopId, id, now.toISOString()),
    ),
    ...change.remove.map((id) =>
      db.prepare("DELETE FROM ha_event_connections WHERE shop_id = ? AND connection_id = ?").bind(shopId, id),
    ),
  ];
  if (statements.length) await db.batch(statements);
}
