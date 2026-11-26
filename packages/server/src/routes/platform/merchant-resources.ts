import { Hono, type Context } from "hono";
import { recordBindingEdit } from "../../pricing-changes.js";
import { createD1Executor, type D1BoundStatementLike } from "@prism/adapter-d1";
import { createDeviceEventRepository } from "@prism/storage-sql";
import type { AppBindings, AuthUser } from "../../bindings.js";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "../../crypto.js";
import { normalizeHinataUrl } from "../../hardware/hinata.js";
import { hostCommandSchema, launcherProgramSchema, programNameSchema } from "../../hardware/node-protocol.js";
import { vkFromKeyText } from "@prism/core";
import { machineRelayPath, nodeRelayPath } from "../../gateway/relay-path.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import {
  loadResource,
  loadResources,
  can,
  coinConfigOf,
  coinKeyOf,
  hinataConfigOf,
  hostConfigOf,
  iotConfigOf,
  keysConfigOf,
  doorConfigOf,
  tableConfigOf,
  readSecret,
  resourceHasLink,
  type Resource,
} from "../../resources/resource.js";
import {
  allocateBeaconId,
  bindingsByNode,
  getNode,
  hashNodeToken,
  hinataNodeSyncStatement,
  iotNodeSyncStatement,
  launcherNodeSyncStatement,
  listNodes,
  mintNodeChannel,
  mintNodeToken,
  resolveNodeChannel,
  syncNodeConfig,
  validateNodePinConflicts,
  type NodeResourceBinding,
} from "../../resources/nodes.js";
import {
  readShopLocationSettings,
  resourceLocationOverrideOf,
  resourceLocationOverrideSchema,
  withResourceLocationOverride,
  writeShopLocationSettingsStatement,
  type ResourceLocationOverride,
} from "../../resources/location.js";
import { createRuntimeBus } from "../../resources/capabilities/runtime.js";
import { createOccupancy } from "../../resources/occupancy/service.js";
import { capabilityWrites, storedCapabilities, type StoredCapability } from "../../resources/capabilities/configure.js";
import {
  announceGroupSchema,
  botReplyTemplatesSchema,
  capabilities,
  replyGroupSchema,
  validateCapabilitySet,
  type BotConfig,
  type CoinConfig,
  type CapabilityId,
  type HaEntityConfig,
  type HinataConfig,
  type HostConfig,
  type IotConfig,
  type KeysConfig,
  type ResourceButton,
} from "../../resources/capabilities/catalog.js";
import { connectedBots, idleSchedule, notifyBotsChangedAfter, refreshShopHub } from "../../durable-objects/shop-hub-client.js";
import {
  getHaConnection,
  normalizeHaUrl,
  openHaConnection,
  resolveHaConnection,
  writeHaConnection,
  type StoredHaConnection,
} from "../../resources/capabilities/ha-connections.js";
import { afterHaChange, scheduleReadAccess } from "./merchant-ha.js";
import { z } from "zod";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { DEFAULT_RESOURCE_GROUP_ID } from "../../resources/billing.js";
import { liveSeatsSql } from "../../resources/capabilities/table-occupancy.js";
import { findResourceGroup } from "../../resources/repository.js";
import { assertBillablePlan } from "./merchant-resource-groups.js";

/** Restore pre-fork merchant machine discovery and audit-history contracts. */
export const merchantResourceRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

/** Sentinel value allowing a newly created resource to bind keys/coin/location to its own new `iot` node in one save. */
const SELF_IOT_REF = "__self__";

export async function assertResourceShop(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return;
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=?",
  ).bind(shopId, user.id).first();
  if (!member) jsonError(403, "你没有这个店铺的管理权限", "FORBIDDEN");
}

export async function canConfigureResource(c: C, user: AuthUser, shopId: string) {
  if (user.role === "admin") return true;
  const row = await c.env.DB.prepare(
    "SELECT s.role FROM shop_staff_accounts a JOIN staff_users s ON s.shop_id=a.shop_id AND s.id=a.staff_id WHERE a.shop_id=? AND a.user_id=? AND s.status='active'",
  ).bind(shopId, user.id).first<{ role: string }>();
  if (row) return row.role === "owner" || row.role === "manager";
  const owner = await c.env.DB.prepare(
    "SELECT 1 FROM shop_members WHERE shop_id=? AND user_id=? AND role='owner'",
  ).bind(shopId, user.id).first();
  return Boolean(owner);
}

export function encryptionKey(c: C): string {
  if (!c.env.URL_ENCRYPTION_KEY) jsonError(503, "设备密钥尚未配置", "DEVICE_ENCRYPTION_UNAVAILABLE");
  return c.env.URL_ENCRYPTION_KEY;
}

type HaBinding = { url: string; entityId: string; token: string };

/** Where a power or air-conditioner capability points, without its token. */
async function describeHa(
  c: C,
  device: Resource,
  capability: "power" | "climate",
): Promise<{ connectionId: string | null; url: string; entityId: string } | null> {
  const bound = device.capabilities.get(capability);
  if (!bound) return null;
  const config = bound.config as HaEntityConfig;
  if (config.connectionId && config.entityId) {
    const connection = await getHaConnection(c.env.DB, device.shopId, config.connectionId);
    return { connectionId: config.connectionId, url: connection?.url ?? "", entityId: config.entityId };
  }
  const raw = await readSecret(c.env.DB, device, capability, "binding", encryptionKey(c));
  if (!raw) return null;
  try {
    const binding = JSON.parse(raw) as HaBinding;
    return { connectionId: null, url: binding.url, entityId: binding.entityId };
  } catch {
    return null;
  }
}

/**
 * Every action this device can perform right now, tagged with the capability
 * that owns it. The store UI groups the action panel by capability, so a
 * capability added to the catalog appears there without a frontend change.
 */
function availableActions(device: Resource): { name: string; capability: string }[] {
  const actions: { name: string; capability: string }[] = [];
  for (const [id] of device.capabilities) {
    for (const action of Object.keys(capabilities[id].actions)) {
      if (can(device, action as Parameters<typeof can>[1]))
        actions.push({ name: action, capability: id });
    }
  }
  return actions;
}

function nodeEndpointWsUrl(c: C): string {
  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  const httpUrl = `${origin.replace(/\/+$/, "")}${nodeRelayPath}`;
  return httpUrl.replace(/^http(s?):\/\//i, "ws$1://");
}

async function presentResource(
  c: C,
  device: Resource,
  shopPublicId: string,
  canConfigure: boolean,
  nodeBindings: ReadonlyMap<string, NodeResourceBinding[]>,
  locationOverride: ResourceLocationOverride,
) {
  const hinata = hinataConfigOf(device);
  const io = device.capabilities.get("hinata_io");
  const ha = await describeHa(c, device, "power");
  const climate = await describeHa(c, device, "climate");
  const embedded = hinata?.transport === "embedded";
  const keys = keysConfigOf(device);
  const coin = coinConfigOf(device);
  const coinBtn = coinKeyOf(device);
  const botConfig = device.capabilities.get("bot")?.config as BotConfig | undefined;
  const host = hostConfigOf(device);
  const iot = iotConfigOf(device);
  const [hinataNode, hostNode, iotNode, botToken] = await Promise.all([
    embedded && hinata?.nodeId ? getNode(c.env.DB, device.shopId, hinata.nodeId).catch(() => null) : null,
    host?.nodeId ? getNode(c.env.DB, device.shopId, host.nodeId).catch(() => null) : null,
    iot?.nodeId ? getNode(c.env.DB, device.shopId, iot.nodeId).catch(() => null) : null,
    botConfig?.tokenId
      ? c.env.DB.prepare(
          "SELECT last_used_at FROM api_tokens WHERE shop_id=? AND id=? AND role='integration' AND status='active'",
        ).bind(device.shopId, botConfig.tokenId).first<{ last_used_at: string | null }>()
      : null,
  ]);
  const wsUrl = nodeEndpointWsUrl(c);
  const iotPinBindings = iot?.nodeId
    ? (nodeBindings.get(iot.nodeId) ?? []).filter((b) => b.pin !== undefined)
    : [];
  return {
    id: device.id,
    publicId: device.publicId,
    shopId: device.shopId,
    shopPublicId,
    name: device.name,
    aliases: device.aliases,
    enabled: device.enabled,
    kind: device.kind,
    hasLink: resourceHasLink(device),
    locationOverride,
    /** Actions the store may send now; the UI is driven by this list. */
    actions: availableActions(device),
    hasHinata: !!io?.secretNames.has("url"),
    hinataUrl: canConfigure && io?.secretNames.has("url")
      ? await readSecret(c.env.DB, device, "hinata_io", "url", encryptionKey(c))
      : null,
    hasPassword: !!io?.secretNames.has("password"),
    homeAssistant: ha ? { connectionId: ha.connectionId, url: canConfigure ? ha.url : "", entityId: ha.entityId } : null,
    climate: climate ? { connectionId: climate.connectionId, url: canConfigure ? climate.url : "", entityId: climate.entityId } : null,
    ttlockLockId: doorConfigOf(device)?.lockId ?? null,
    table: tableConfigOf(device),
    // Unified cabinet buttons (`keys` capability): keyboard (Launcher/IO) or GPIO pulse (IoT).
    hasKeys: device.capabilities.has("keys"),
    keys: keys?.buttons ?? [],
    host,
    hasHostToken: !!host && !!hostNode?.hasToken,
    hostWsUrl: host ? wsUrl : null,
    hostOnline: null as boolean | null,
    hostVersion: null as string | null,
    hostProgram: null as string | null,
    iot,
    hasIotToken: !!iot && !!iotNode?.hasToken,
    iotWsUrl: iot ? wsUrl : null,
    iotOnline: null as boolean | null,
    iotVersion: null as string | null,
    iotModel: null as string | null,
    iotBindings: iotPinBindings,
    // The token itself is only returned when it is issued.
    bot: (() => {
      if (!botConfig) return null;
      const { tokenId: _token, ...settings } = botConfig;
      return settings;
    })(),
    hasBotToken: !!botToken,
    botLastUsedAt: botToken?.last_used_at ?? null,
    botOnline: null as boolean | null,
    // Coin is a capability of its own: picks a button in `keys` plus limits & optional GPIO feedback.
    coin: coin ?? null,
    coinKeyId: coin?.keyId ?? null,
    coinKey: coinBtn?.mode === "keyboard" ? coinBtn.key : 0,
    coinEnabled: can(device, "coin"),
    coinAfterSwipe: !!coin?.afterSwipe,
    coinCap: coin?.cap ?? null,
    relayConnection: embedded ? "embedded" : "external",
    hinataNodeId: embedded ? (hinata?.nodeId ?? null) : null,
    hasRelayToken: embedded && (!!hinataNode?.hasToken || !!io?.credentialHash),
    relayUrl: embedded ? relayDeviceUrl(c) : null,
    relayOnline: null as boolean | null,
    relayE2ee: null as boolean | null,
  };
}

type NodeLive = { online: boolean; e2ee: boolean; version: string | null; model: string | null; program: string | null };

/** Live WebSocket status for embedded HINATA IO, Launcher (`host`), and IoT (`iot`) nodes. */
async function liveNodeStatuses(
  c: C,
  devices: readonly Resource[],
): Promise<{
  hinata: Map<string, NodeLive>;
  host: Map<string, NodeLive>;
  iot: Map<string, NodeLive>;
}> {
  const hinata = new Map<string, NodeLive>();
  const host = new Map<string, NodeLive>();
  const iot = new Map<string, NodeLive>();
  const relay = machineRelayNamespace(c.env);
  if (!relay) return { hinata, host, iot };

  await Promise.all(
    devices.flatMap((device) => {
      const tasks: Promise<void>[] = [];
      const hCfg = hinataConfigOf(device);
      if (hCfg?.transport === "embedded") {
        tasks.push((async () => {
          const target = await resolveNodeChannel(c.env.DB, device.shopId, hCfg.nodeId, hCfg.channel).catch(() => null);
          if (!target) return;
          try {
            const st = await relay.getByName(target.channel).getCapabilities();
            hinata.set(device.id, { online: st.online, e2ee: st.e2ee, version: null, model: null, program: null });
          } catch {
            // Leave unreported.
          }
        })());
      }
      const hostCfg = hostConfigOf(device);
      if (hostCfg?.nodeId) {
        tasks.push((async () => {
          const target = await resolveNodeChannel(c.env.DB, device.shopId, hostCfg.nodeId).catch(() => null);
          if (!target) return;
          try {
            const st = await relay.getByName(target.channel).nodeStatus();
            host.set(device.id, { online: st.online, e2ee: st.e2ee, version: st.version, model: st.model, program: st.program });
          } catch {
            // Leave unreported.
          }
        })());
      }
      const iotCfg = iotConfigOf(device);
      if (iotCfg?.nodeId) {
        tasks.push((async () => {
          const target = await resolveNodeChannel(c.env.DB, device.shopId, iotCfg.nodeId).catch(() => null);
          if (!target) return;
          try {
            const st = await relay.getByName(target.channel).nodeStatus();
            iot.set(device.id, { online: st.online, e2ee: st.e2ee, version: st.version, model: st.model, program: st.program });
          } catch {
            // Leave unreported.
          }
        })());
      }
      return tasks;
    }),
  );
  return { hinata, host, iot };
}

/** What a direct IO last reported, kept short for the board. Null for an IO that never reported it. */
export type IoSummary = { version: string | null; readers: number | null; credit: number | null };

async function ioSummaries(c: C, devices: readonly Resource[]): Promise<Map<string, IoSummary>> {
  const summaries = new Map<string, IoSummary>();
  const embedded = devices.filter((device) => hinataConfigOf(device)?.transport === "embedded");
  const shopId = embedded[0]?.shopId;
  if (!shopId) return summaries;
  const rows = (await c.env.DB.prepare(
    `SELECT device_id, key, value_json FROM device_state
     WHERE shop_id = ? AND capability = 'hinata_io' AND key IN ('version','readers','cabinet')
       AND device_id IN (SELECT value FROM json_each(?))`,
  ).bind(shopId, JSON.stringify(embedded.map((device) => device.id)))
    .all<{ device_id: string; key: string; value_json: string }>()).results;
  for (const device of embedded) summaries.set(device.id, { version: null, readers: null, credit: null });
  for (const row of rows) {
    const summary = summaries.get(row.device_id)!;
    let value: unknown;
    try {
      value = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (row.key === "version" && typeof value === "string") summary.version = value;
    if (row.key === "readers" && Array.isArray(value)) summary.readers = value.length;
    if (row.key === "cabinet" && value && typeof value === "object") {
      const credit = (value as { players?: Array<{ credit?: unknown }> }).players?.[0]?.credit;
      if (typeof credit === "number") summary.credit = credit;
    }
  }
  return summaries;
}

async function presentWithStatus(c: C, devices: readonly Resource[], shopPublicId: string, canConfigure: boolean) {
  const shopId = devices[0]?.shopId;
  const [statuses, bindings, bots, io, nodeBindings, locationSettings] = await Promise.all([
    liveNodeStatuses(c, devices),
    billingBindings(c, devices),
    shopId && devices.some((device) => device.capabilities.has("bot")) ? connectedBots(c.env, shopId) : null,
    ioSummaries(c, devices),
    shopId ? bindingsByNode(c.env.DB, shopId) : new Map<string, NodeResourceBinding[]>(),
    shopId ? readShopLocationSettings(c.env.DB, shopId) : null,
  ]);
  return Promise.all(devices.map(async (device) => {
    const locOverride = locationSettings
      ? resourceLocationOverrideOf(locationSettings, device.id)
      : { mode: "inherit" as const, beaconNodeId: null, rssiThreshold: null };
    const presented = await presentResource(c, device, shopPublicId, canConfigure, nodeBindings, locOverride);
    const liveIo = statuses.hinata.get(device.id);
    const liveHost = statuses.host.get(device.id);
    const liveIot = statuses.iot.get(device.id);
    const binding = bindings.get(device.id);
    return {
      ...presented,
      resourceGroupId: binding?.groupId ?? DEFAULT_RESOURCE_GROUP_ID,
      pricingConfigOverrideId: binding?.overrideId ?? null,
      capacity: binding?.capacity ?? 0,
      occupancyMinutes: binding?.occupancyMinutes ?? 15,
      relayOnline: liveIo ? liveIo.online : null,
      relayE2ee: liveIo ? liveIo.e2ee : null,
      hostOnline: liveHost ? liveHost.online : null,
      hostVersion: liveHost?.version ?? null,
      hostProgram: liveHost?.program ?? null,
      iotOnline: liveIot ? liveIot.online : null,
      iotVersion: liveIot?.version ?? null,
      iotModel: liveIot?.model ?? null,
      botOnline: device.capabilities.has("bot") && bots !== null ? bots.includes(device.id) : null,
      io: io.get(device.id) ?? null,
    };
  }));
}

/** Which group each resource bills from, and its own plan when it has one. */
async function billingBindings(c: C, devices: readonly Resource[]) {
  const bindings = new Map<string, { groupId: string | null; overrideId: string | null; capacity: number; occupancyMinutes: number }>();
  const shopId = devices[0]?.shopId;
  if (!shopId) return bindings;
  const rows = await c.env.DB.prepare(
    `SELECT id, resource_group_id AS groupId, pricing_config_override_id AS overrideId,
       capacity, occupancy_minutes AS occupancyMinutes FROM machines
     WHERE shop_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).bind(shopId, JSON.stringify(devices.map((device) => device.id)))
    .all<{ id: string; groupId: string | null; overrideId: string | null; capacity: number; occupancyMinutes: number }>();
  for (const row of rows.results) bindings.set(row.id, row);
  return bindings;
}

async function shopPublicId(c: C, shopId: string): Promise<string> {
  const row = await c.env.DB.prepare("SELECT public_id FROM shops WHERE id=?").bind(shopId).first<{ public_id: string }>();
  if (!row) jsonError(404, "没有找到这个店铺", "SHOP_NOT_FOUND");
  return row.public_id;
}

/** The exact `[aimeio] serverUrl` value a store pastes into the machine's INI. */
export function relayDeviceUrl(c: C): string {
  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  return `${origin.replace(/\/+$/, "")}${machineRelayPath}`;
}

merchantResourceRouter.get("/machines", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  const canConfigure = await canConfigureResource(c, user, shopId);
  const devices = await loadResources(c.env.DB, shopId, c.env.URL_ENCRYPTION_KEY);
  // Doors first, as the board has always listed them.
  const ordered = [...devices.filter((d) => d.capabilities.has("door")), ...devices.filter((d) => !d.capabilities.has("door"))];
  return c.json({ machines: await presentWithStatus(c, ordered, await shopPublicId(c, shopId), canConfigure) });
});

merchantResourceRouter.get("/machines/:id/events", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c, user, machine.shop_id);
  await shopTimes(c, machine.shop_id);
  const limit = Math.floor(Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200));
  const before = c.req.query("before");
  if (before && before.length > 200) jsonError(400, "无效的记录游标", "INVALID_CURSOR");
  const events = await createDeviceEventRepository(createD1Executor(c.env.DB, machine.shop_id))
    .listEvents({ deviceId: c.req.param("id"), limit: limit + 1, before });
  const page = events.slice(0, limit);
  const others = [...new Set(page.flatMap((event) => [event.deviceId, event.via?.resourceId ?? null])
    .filter((id): id is string => !!id && id !== c.req.param("id")))];
  const names = new Map(others.length
    ? (await c.env.DB.prepare("SELECT id, name FROM machines WHERE shop_id=? AND id IN (SELECT value FROM json_each(?))")
        .bind(machine.shop_id, JSON.stringify(others)).all<{ id: string; name: string }>()).results.map((row) => [row.id, row.name])
    : []);
  const named = (id: string | null | undefined) =>
    id && id !== c.req.param("id") ? { id, name: names.get(id) ?? null } : null;
  const playerOf = (event: (typeof page)[number]) =>
    event.playerId ?? (typeof event.payload.forPlayerId === "string" ? event.payload.forPlayerId : null);
  const playerIds = [...new Set(page.map(playerOf).filter((id): id is string => !!id))];
  const players = new Map(playerIds.length
    ? (await c.env.DB.prepare("SELECT id, display_name FROM players WHERE shop_id=? AND id IN (SELECT value FROM json_each(?))")
        .bind(machine.shop_id, JSON.stringify(playerIds)).all<{ id: string; display_name: string | null }>()).results.map((row) => [row.id, row.display_name])
    : []);
  return c.json({
    nextCursor: events.length > limit ? page.at(-1)!.id : null,
    events: page.map((event) => ({
      id: event.id,
      device: named(event.deviceId),
      player: playerOf(event) ? { id: playerOf(event)!, name: players.get(playerOf(event)!) ?? null } : null,
      via: event.via ? { channel: event.via.channel, resource: named(event.via.resourceId) } : null,
      capability: event.capability,
      kind: event.kind,
      name: event.name,
      origin: event.origin,
      operationId: event.operationId,
      parentOperationId: event.parentOperationId,
      at: event.occurredAt.toISOString(),
      payload: event.payload,
    })),
  });
});

merchantResourceRouter.get("/machines/:id/cabinet", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c, user, machine.shop_id);
  const rows = (await c.env.DB.prepare(
    "SELECT key, value_json, changed_at FROM device_state WHERE shop_id=? AND device_id=? AND capability='hinata_io' AND key IN ('cabinet','readers','version','link')",
  ).bind(machine.shop_id, c.req.param("id")).all<{ key: string; value_json: string; changed_at: string }>()).results;
  const row = (key: string) => rows.find((item) => item.key === key);
  const value = (key: string) => { const found = row(key); return found ? JSON.parse(found.value_json) : null; };
  return c.json({
    cabinet: value("cabinet"), changedAt: row("cabinet")?.changed_at ?? null,
    io: { version: value("version"), readers: value("readers"), online: value("link") === "online" },
  });
});

merchantResourceRouter.post("/machines/:id/cabinet/refresh", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c, user, machine.shop_id);
  const device = await loadResource(c.env.DB, machine.shop_id, c.req.param("id"));
  const hinata = device ? hinataConfigOf(device) : null;
  const relay = machineRelayNamespace(c.env);
  const target = hinata && hinata.transport === "embedded"
    ? await resolveNodeChannel(c.env.DB, machine.shop_id, hinata.nodeId, hinata.channel)
    : null;
  if (!target || !relay)
    jsonError(409, "只有直连本平台的机台能读取机台状态", "DEVICE_ACTION_UNSUPPORTED");
  const read = await relay.getByName(target.channel).readCabinet();
  if (!read.ok) jsonError(409, read.error, "CABINET_READ_FAILED");
  const { revision: _revision, readAtMs, ...cabinet } = read.cabinet;
  return c.json({ cabinet, readAt: new Date(readAtMs).toISOString() });
});

/** Managed host (PRiSM Launcher) status, configuration, and audited commands. */
async function managedHost(c: C) {
  const user = requireUser(c);
  const id = c.req.param("id")!;
  const row = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=? AND enabled=1").bind(id).first<{ shop_id: string }>();
  if (!row) jsonError(404, "没有找到启用的机台", "DEVICE_NOT_FOUND");
  if (!await canConfigureResource(c, user, row.shop_id)) jsonError(403, "需要设备管理权限", "FORBIDDEN");
  const device = await loadResource(c.env.DB, row.shop_id, id);
  if (!device) jsonError(404, "没有找到启用的机台", "DEVICE_NOT_FOUND");
  return { user, shopId: row.shop_id, device };
}

merchantResourceRouter.get("/machines/:id/host", async (c) => {
  const { shopId, device } = await managedHost(c);
  const host = hostConfigOf(device);
  if (!host) return c.json({ bound: false, online: false, program: null, nodeId: null, config: null });
  const target = await resolveNodeChannel(c.env.DB, shopId, host.nodeId);
  const relay = machineRelayNamespace(c.env);
  const live = target && relay ? await relay.getByName(target.channel).nodeStatus().catch(() => null) : null;
  return c.json({
    bound: true,
    online: live?.online ?? false,
    program: live?.program ?? null,
    version: live?.version ?? null,
    nodeId: host.nodeId,
    config: { default: host.defaultProgram, programs: host.programs },
  });
});

const hostConfigPutSchema = z.object({
  nodeId: z.string().min(1).optional(),
  default: programNameSchema.nullable().optional(),
  defaultProgram: programNameSchema.nullable().optional(),
  programs: z.array(launcherProgramSchema).max(64),
});

merchantResourceRouter.put("/machines/:id/host/config", async (c) => {
  const { shopId, device } = await managedHost(c);
  const parsed = hostConfigPutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) jsonError(422, "主机启动配置无效", "INVALID_HOST_CONFIG");
  const existing = hostConfigOf(device);
  const nodeId = parsed.data.nodeId ?? existing?.nodeId;
  if (!nodeId) jsonError(400, "请先绑定一个 Launcher 节点", "HOST_NODE_REQUIRED");
  const node = await getNode(c.env.DB, shopId, nodeId);
  if (!node || node.kind !== "launcher") jsonError(404, "绑定的 Launcher 节点不存在", "NODE_NOT_FOUND");
  const defaultProgram = parsed.data.defaultProgram !== undefined
    ? parsed.data.defaultProgram
    : parsed.data.default !== undefined
      ? parsed.data.default
      : existing?.defaultProgram ?? null;
  const nextHost = capabilities.host.config.safeParse({
    nodeId,
    defaultProgram,
    programs: parsed.data.programs,
  });
  if (!nextHost.success) jsonError(422, "默认程序必须存在于程序列表中且程序名必须唯一", "INVALID_HOST_CONFIG");
  const stored = await storedCapabilities(c.env.DB, shopId, device.id);
  stored.set("host", { config: nextHost.data, secrets: {}, credentialHash: null });
  await c.env.DB.batch(capabilityWrites(c.env.DB, { shopId, deviceId: device.id, next: stored, now: new Date() }));
  await syncNodeConfig(c.env.DB, c.env, shopId, nodeId);
  if (existing?.nodeId && existing.nodeId !== nodeId) {
    await syncNodeConfig(c.env.DB, c.env, shopId, existing.nodeId);
  }
  return c.json({ ok: true, config: nextHost.data });
});

merchantResourceRouter.post("/machines/:id/host/commands", async (c) => {
  const { user, shopId, device } = await managedHost(c);
  if (!hostConfigOf(device)) jsonError(409, "请先绑定 Launcher 节点", "HOST_NOT_BOUND");
  const parsed = hostCommandSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) jsonError(422, "Launcher 指令无效", "INVALID_HOST_COMMAND");
  const cmd = parsed.data;
  const action = (`host.${cmd.action}` as "host.switch" | "host.key" | "host.text" | "host.screenshot" | "host.reboot" | "host.shutdown");
  const payload: Record<string, unknown> =
    cmd.action === "switch" ? { name: cmd.name }
    : cmd.action === "key" ? { key: cmd.key, count: cmd.count }
    : cmd.action === "text" ? { text: cmd.text }
    : {};
  const bus = createRuntimeBus({ db: c.env.DB, env: c.env, shopId, via: { channel: "merchant", resourceId: null } });
  const outcome = await bus.perform({
    device,
    action,
    actor: { type: "staff", staffId: user.id },
    payload,
  });
  c.header("Cache-Control", "no-store");
  if (outcome.operation.status !== "succeeded") {
    return c.json({ ok: false, error: outcome.operation.failure ?? "Launcher 指令执行失败" }, 409);
  }
  return c.json({ ok: true, ...(outcome.result !== undefined ? { result: outcome.result } : {}) });
});

async function shopTimes(c: C, shopId: string) {
  const row = await c.env.DB.prepare(
    "SELECT COALESCE((SELECT json_extract(value_json, '$.timeZone') FROM app_settings WHERE shop_id = ? AND key = 'store.profile'), 'Asia/Shanghai') AS time_zone",
  ).bind(shopId).first<{ time_zone: string }>();
  if (row?.time_zone) c.set("responseTimeZone", row.time_zone);
}

merchantResourceRouter.get("/machines/occupancy", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  await shopTimes(c, shopId);
  const [resources, offAt] = await Promise.all([
    createOccupancy({ db: c.env.DB, shopId }).current(),
    idleSchedule(c.env, shopId),
  ]);
  return c.json({
    powerOffAt: Object.fromEntries(Object.entries(offAt).map(([id, at]) => [id, new Date(at).toISOString()])),
    resources: resources.map((resource) => ({
      resourceId: resource.resourceId,
      capacity: resource.capacity,
      source: resource.source,
      occupants: resource.occupants.map((occupant) => ({
        playerId: occupant.playerId,
        displayName: occupant.displayName,
        startedAt: occupant.since.toISOString(),
        lastSeenAt: occupant.lastSeenAt.toISOString(),
        expiresAt: occupant.expiresAt?.toISOString() ?? null,
        billing: occupant.billing,
      })),
    })),
  });
});

merchantResourceRouter.get("/machines/:id/occupancy", async (c) => {
  const user = requireUser(c);
  const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
    .bind(c.req.param("id")).first<{ shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c, user, machine.shop_id);
  await shopTimes(c, machine.shop_id);
  const before = c.req.query("before");
  const history = await createOccupancy({ db: c.env.DB, shopId: machine.shop_id }).history(c.req.param("id"), {
    limit: Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200),
    ...(before && Number.isFinite(Date.parse(before)) ? { before: new Date(before) } : {}),
  });
  return c.json({
    entries: history.map((entry) => ({
      id: entry.id,
      playerId: entry.playerId,
      displayName: entry.displayName,
      source: entry.source,
      startedAt: entry.startedAt.toISOString(),
      lastSeenAt: entry.lastSeenAt.toISOString(),
      endedAt: entry.endedAt?.toISOString() ?? null,
      endReason: entry.endReason,
    })),
  });
});

merchantResourceRouter.get("/login-events", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  const machineId = c.req.query("machineId");
  if (shopId) await assertResourceShop(c, user, shopId);
  if (machineId) {
    const machine = await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?")
      .bind(machineId).first<{ shop_id: string }>();
    if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
    await assertResourceShop(c, user, machine.shop_id);
  }
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
  const where: string[] = [];
  const bindings: Array<string | number> = [];
  if (user.role !== "admin") {
    where.push("EXISTS (SELECT 1 FROM shop_members sm WHERE sm.shop_id=shops.id AND sm.user_id=?)");
    bindings.push(user.id);
  }
  if (shopId) { where.push("shops.id=?"); bindings.push(shopId); }
  if (machineId) { where.push("machines.id=?"); bindings.push(machineId); }
  const sql = `SELECT e.id, e.created_at AS createdAt, e.result, e.risk_result AS riskResult,
    e.response_code AS responseCode, e.error_message AS errorMessage,
    e.distance_meters AS distanceMeters, machines.name AS machineName,
    shops.name AS shopName, i.display_name AS userName, cards.label AS cardLabel
    FROM machine_login_events e
    LEFT JOIN machines ON machines.id=e.machine_id
    LEFT JOIN shops ON shops.id=machines.shop_id
    LEFT JOIN users ON users.id=e.user_id
    LEFT JOIN auth_identities i ON i.id=(SELECT id FROM auth_identities WHERE user_id=users.id AND provider='munet' ORDER BY created_at LIMIT 1)
    LEFT JOIN cards ON cards.id=e.card_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY e.created_at DESC LIMIT ?`;
  const result = await c.env.DB.prepare(sql).bind(...bindings, limit).all();
  return c.json({ events: result.results });
});

merchantResourceRouter.get("/device-bindings", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  if (!(await canConfigureResource(c, user, shopId))) {
    jsonError(403, "只读账号不能配置资源", "FORBIDDEN");
  }
  return c.json({ bindings: [] });
});

const urlInput = z.string().trim().url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  "连接地址必须为 HTTP 或 HTTPS",
);
const haEntityInput = (entity: z.ZodString) => z.object({
  connectionId: z.string().min(1).optional(),
  url: urlInput.optional(),
  entityId: entity,
  token: z.string().trim().max(4096).optional(),
}).refine((value) => !!value.connectionId || !!value.url, "请选择 Home Assistant 连接").nullable();
const homeAssistantInput = haEntityInput(z.string().regex(/^(switch|input_boolean)\.[a-z0-9_]+$/));
const climateInput = haEntityInput(z.string().regex(/^climate\.[a-z0-9_]+$/, "空调实体需要是 climate.* 实体"));

const buttonInput = z.union([
  z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    name: z.string().trim().min(1, "请填写按键名称").max(20, "按键名称最多 20 个字"),
    mode: z.literal("gpio"),
    nodeId: z.string().min(1),
    pin: z.number().int().min(0).max(255),
    pulseMs: z.number().int().min(10).max(5000).default(80),
    activeLow: z.boolean().default(true),
  }),
  z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
    name: z.string().trim().min(1, "请填写按键名称").max(20, "按键名称最多 20 个字"),
    mode: z.literal("keyboard").optional(),
    key: z.union([z.string().max(12), z.number().int()]),
  }),
]);

const machineInput = z.object({
  shopId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["machine", "door"]).default("machine"),
  enabled: z.boolean().default(true),
  aliases: z.array(z.string().trim().min(1).max(80)).max(32).default([]),
  hinataUrl: z.string().trim().transform(normalizeHinataUrl).refine(
    (value) => { try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; } },
    "请填写正确的机台连接地址",
  ).nullable().optional(),
  hinataPassword: z.string().trim().max(128).nullable().optional(),
  homeAssistant: homeAssistantInput.optional(),
  climate: climateInput.optional(),
  ttlockLockId: z.number().int().positive().nullable().optional(),
  /** Unified cabinet buttons (`keys` capability), or null to remove `keys`. */
  keys: z.array(buttonInput).max(16, "最多 16 个按键").nullable().optional(),
  /** Explicitly toggle `keys` capability on even when the button list is currently empty. */
  keysEnabled: z.boolean().optional(),
  /** Coin capability: selects one button in `keys` + cap/afterSwipe + optional GPIO feedback. */
  coin: z.object({
    keyId: z.string().max(40).nullable().optional(),
    cap: z.number().int().min(1).max(99).nullable().optional(),
    afterSwipe: z.boolean().optional(),
    feedbackNodeId: z.string().min(1).nullable().optional(),
    feedbackPin: z.number().int().min(0).max(255).nullable().optional(),
    feedbackEdge: z.enum(["falling", "rising", "both"]).optional(),
    feedbackDebounceMs: z.number().int().min(1).max(2000).optional(),
    feedbackSignal: z.enum(["cabinet.coin", "cabinet.consumed", "cabinet.activity"]).optional(),
    // Legacy compatibility fields (converted to a GPIO button in `keys`).
    method: z.enum(["key", "gpio"]).optional(),
    nodeId: z.string().min(1).nullable().optional(),
    pin: z.number().int().min(0).max(255).nullable().optional(),
    pulseMs: z.number().int().min(10).max(5000).optional(),
    activeLow: z.boolean().optional(),
  }).nullable().optional(),
  hinataNodeId: z.string().min(1).nullable().optional(),
  /** Managed PC host capability (`host`) — auto-owns a 1:1 `launcher` node unless `nodeId` is given. */
  host: z.object({
    nodeId: z.string().min(1).optional(),
    defaultProgram: programNameSchema.nullable().optional(),
    default: programNameSchema.nullable().optional(),
    programs: z.array(launcherProgramSchema).max(64).default([]),
  }).nullable().optional(),
  rotateHostToken: z.boolean().optional(),
  /** Hardware-agnostic IoT controller capability (`iot`) — auto-owns a 1:1 `iot` node. */
  iot: z.object({
    nodeId: z.string().min(1).optional(),
    haWatch: z.boolean().optional(),
    ble: z.object({
      enabled: z.boolean().optional(),
      beaconId: z.number().int().min(1).max(65535).nullable().optional(),
      txPower: z.number().int().min(-100).max(20).optional(),
      rssiThreshold: z.number().int().min(-100).max(-20).optional(),
    }).optional(),
  }).nullable().optional(),
  rotateIotToken: z.boolean().optional(),
  /** Resource-level location verification override (`inherit` | `gps` | `ble` | `none`). */
  locationOverride: resourceLocationOverrideSchema.nullable().optional(),
  // Legacy flat coin fields for older clients.
  coinKey: z.number().int().min(0).max(65535).optional(),
  coinKeyId: z.string().max(40).nullable().optional(),
  coinMethod: z.enum(["key"]).optional(),
  coinAfterSwipe: z.boolean().optional(),
  coinCap: z.number().int().min(1).max(99).nullable().optional(),
  relayConnection: z.enum(["external", "embedded"]).optional(),
  rotateRelayToken: z.boolean().optional(),
  bot: z.object({
    replyTemplates: botReplyTemplatesSchema.optional(),
    replyGroups: z.array(replyGroupSchema).max(10).optional(),
    playerCommands: z.enum(["all", "readonly"]).optional(),
    readOnlyNotice: z.string().max(200).optional(),
    staffCommands: z.boolean().optional(),
    powerOffStaffOnly: z.boolean().optional(),
    doorResourceId: z.string().min(1).nullable().optional(),
    doorPasswordOnEntry: z.boolean().optional(),
    idleReminderMinutes: z.number().int().min(0).max(120).optional(),
    announceGroups: z.array(announceGroupSchema).max(10).optional(),
  }).strict().nullable().optional(),
  rotateBotToken: z.boolean().optional(),
  resourceGroupId: z.string().min(1).nullable().optional(),
  pricingConfigOverrideId: z.string().min(1).nullable().optional(),
  capacity: z.number().int().min(0).max(16).optional(),
  occupancyMinutes: z.number().int().min(1).max(1440).optional(),
  table: z.object({
    pricingConfigIds: z.array(z.string().min(1)).max(1, "桌游桌只能选择一个计费方案"),
    startWhen: z.enum(["full", "seated"]).optional(),
  }).nullable().optional(),
});
const patchInput = machineInput.partial();
type MachineInput = z.infer<typeof patchInput>;

async function tableSeated(c: C, table: Resource): Promise<boolean> {
  return !!await c.env.DB.prepare(
    `SELECT 1 FROM (${liveSeatsSql}) WHERE shop_id=? AND machine_id=? LIMIT 1`,
  ).bind(table.shopId, table.id).first();
}

async function validateTable(c: C, shopId: string, current: Resource | null, body: MachineInput) {
  if (body.table === undefined) return;
  const ids = body.table?.pricingConfigIds ?? [];
  if (ids.length) {
    const active = await c.env.DB.prepare(
      "SELECT id FROM pricing_configs WHERE shop_id=? AND enabled=1 AND status='active'",
    ).bind(shopId).all<{ id: string }>();
    const valid = new Set(active.results.map((row) => row.id));
    if (ids.some((id) => !valid.has(id))) jsonError(400, "请选择有效的桌游计费规则", "TABLE_PRICING_INVALID");
  }
  const before = current ? tableConfigOf(current) : null;
  const after = body.table ? { pricingConfigIds: ids, startWhen: body.table.startWhen ?? before?.startWhen ?? "full" } : null;
  const was = before ? { pricingConfigIds: before.pricingConfigIds, startWhen: before.startWhen ?? "full" } : null;
  if (current && JSON.stringify(after) !== JSON.stringify(was)) {
    if (await tableSeated(c, current)) jsonError(409, "请先让玩家下桌再修改桌游配置", "TABLE_IN_USE");
  }
}

/** Check whether any OTHER resource in this shop still references an IoT controller node. */
async function findExternalIotReferrers(
  c: C,
  shopId: string,
  ownerDeviceId: string,
  iotNodeId: string,
): Promise<string[]> {
  const referrers = new Set<string>();
  const byNode = await bindingsByNode(c.env.DB, shopId);
  for (const b of byNode.get(iotNodeId) ?? []) {
    if (b.deviceId !== ownerDeviceId && b.capability !== "iot") {
      referrers.add(b.deviceName);
    }
  }
  const locSettings = await readShopLocationSettings(c.env.DB, shopId);
  const locReferrerIds = Object.entries(locSettings.resources)
    .filter(([id, ov]) => id !== ownerDeviceId && ov.mode === "ble" && ov.beaconNodeId === iotNodeId)
    .map(([id]) => id);
  if (locReferrerIds.length) {
    const rows = (await c.env.DB.prepare(
      "SELECT name FROM machines WHERE shop_id=? AND id IN (SELECT value FROM json_each(?))",
    ).bind(shopId, JSON.stringify(locReferrerIds)).all<{ name: string }>()).results;
    for (const r of rows) referrers.add(r.name);
  }
  return [...referrers];
}

async function nextCapabilities(
  c: C,
  shopId: string,
  machineId: string,
  machineName: string,
  machineEnabled: boolean,
  stored: ReadonlyMap<CapabilityId, StoredCapability>,
  body: MachineInput,
): Promise<{
  next: Map<CapabilityId, StoredCapability>;
  relayToken: string | null;
  hostToken: string | null;
  iotToken: string | null;
  connections: StoredHaConnection[];
  nodeStatements: D1BoundStatementLike[];
  syncNodes: Set<string>;
  iotChanged: boolean;
  selfIotNodeId: string | null;
}> {
  const next = new Map(stored);
  const seal = (value: string) => encryptSecret(value, encryptionKey(c));
  const connections: StoredHaConnection[] = [];
  const nodeStatements: D1BoundStatementLike[] = [];
  const syncNodes = new Set<string>();
  let iotChanged = false;
  const now = new Date();

  const previousHa = async (capability: StoredCapability | undefined): Promise<{ url: string; token: string } | null> => {
    if (!capability) return null;
    const connectionId = (capability.config as HaEntityConfig).connectionId;
    if (connectionId) {
      const open = await openHaConnection(c.env.DB, shopId, connectionId, encryptionKey(c));
      return open ? { url: open.url, token: open.token } : null;
    }
    if (!capability.secrets.binding) return null;
    try { return JSON.parse(await decryptSecret(capability.secrets.binding, encryptionKey(c))) as HaBinding; }
    catch { return null; }
  };

  const connectionFor = async (
    input: NonNullable<MachineInput["homeAssistant"]>,
    fallbacks: Array<StoredCapability | undefined>,
  ): Promise<string> => {
    if (input.connectionId) {
      if (!await getHaConnection(c.env.DB, shopId, input.connectionId))
        jsonError(400, "没有找到这个 Home Assistant 连接", "HA_CONNECTION_NOT_FOUND");
      return input.connectionId;
    }
    const url = normalizeHaUrl(input.url!);
    let token = input.token || null;
    for (const fallback of fallbacks) {
      if (token) break;
      const previous = await previousHa(fallback);
      if (previous && normalizeHaUrl(previous.url) === url) token = previous.token;
    }
    const pending = connections.find((connection) => connection.url === url);
    if (!token && pending) return pending.id;
    const resolved = await resolveHaConnection(c.env.DB, shopId, encryptionKey(c), { url, token });
    if (!resolved) jsonError(400, "请填写 Home Assistant 令牌", "HOME_ASSISTANT_TOKEN_REQUIRED");
    if (resolved.created && !connections.some((connection) => connection.id === resolved.connection.id))
      connections.push(resolved.connection);
    return resolved.connection.id;
  };

  if (body.homeAssistant === null) next.delete("power");
  else if (body.homeAssistant) {
    const connectionId = await connectionFor(body.homeAssistant, [stored.get("power")]);
    next.set("power", { config: { connectionId, entityId: body.homeAssistant.entityId }, secrets: {}, credentialHash: null });
  }

  if (body.climate === null) next.delete("climate");
  else if (body.climate) {
    const connectionId = await connectionFor(body.climate, [stored.get("climate"), next.get("power"), stored.get("power")]);
    next.set("climate", { config: { connectionId, entityId: body.climate.entityId }, secrets: {}, credentialHash: null });
  }

  if (body.ttlockLockId === null) next.delete("door");
  else if (body.ttlockLockId !== undefined)
    next.set("door", { config: { lockId: body.ttlockLockId }, secrets: {}, credentialHash: null });

  if (body.table === null) next.delete("table");
  else if (body.table) next.set("table", {
    config: {
      ...body.table,
      startWhen: body.table.startWhen ?? (stored.get("table")?.config.startWhen as string | undefined) ?? "full",
    },
    secrets: {},
    credentialHash: null,
  });

  // --- IoT controller capability (`iot`) — auto-managed 1:1 `iot_<id>` node ---
  const iotBefore = stored.get("iot")?.config as IotConfig | undefined;
  let iotToken: string | null = null;
  let selfIotNodeId: string | null = iotBefore?.nodeId ?? null;

  if (body.iot === null) {
    if (iotBefore?.nodeId) {
      const refs = await findExternalIotReferrers(c, shopId, machineId, iotBefore.nodeId);
      if (refs.length) {
        jsonError(409, `该 IoT 控制器仍被「${refs.join("、")}」引用，请先解除引用后再移除`, "NODE_IN_USE");
      }
      if (iotBefore.nodeId === `iot_${machineId}`) {
        nodeStatements.push(c.env.DB.prepare(
          "DELETE FROM shop_nodes WHERE shop_id=? AND id=? AND kind='iot'",
        ).bind(shopId, iotBefore.nodeId));
      }
      iotChanged = true;
    }
    selfIotNodeId = null;
    next.delete("iot");
  } else if (body.iot !== undefined || (body.rotateIotToken && iotBefore)) {
    const nodeId = body.iot?.nodeId ?? iotBefore?.nodeId ?? `iot_${machineId}`;
    const existingNode = await getNode(c.env.DB, shopId, nodeId).catch(() => null);
    if (body.iot?.nodeId && (!existingNode || existingNode.kind !== "iot")) {
      jsonError(404, "绑定的 IoT 控制器不存在", "NODE_NOT_FOUND");
    }
    // IoT controllers always participate in BLE beacon advertising and HA watching automatically.
    const haWatch = true;
    const bleEnabled = true;
    let beaconId = body.iot?.ble?.beaconId !== undefined
      ? body.iot.ble.beaconId
      : (iotBefore?.ble?.beaconId ?? null);
    if (beaconId === null) {
      beaconId = await allocateBeaconId(c.env.DB, shopId, nodeId);
    } else {
      const siblings = await listNodes(c.env.DB, shopId, "iot");
      const clash = siblings.find(
        (other) => other.id !== nodeId && (other.config as { ble?: { beaconId?: number | null } }).ble?.beaconId === beaconId,
      );
      if (clash) jsonError(409, `蓝牙信标编号 ${beaconId} 已被「${clash.name}」使用`, "BEACON_ID_CONFLICT");
    }
    const txPower = body.iot?.ble?.txPower ?? iotBefore?.ble?.txPower ?? -59;
    const rssiThreshold = body.iot?.ble?.rssiThreshold ?? iotBefore?.ble?.rssiThreshold ?? -75;

    let credentialHash: string | null = null;
    if (body.rotateIotToken) {
      iotToken = mintNodeToken("iot");
      credentialHash = await hashNodeToken(iotToken);
    }
    const channel = existingNode?.channel ?? mintNodeChannel("iot");
    const parsedIot = capabilities.iot.config.parse({
      nodeId,
      haWatch,
      ble: { enabled: bleEnabled, beaconId, txPower, rssiThreshold },
    });
    nodeStatements.push(await iotNodeSyncStatement(c.env.DB, {
      shopId,
      machineName,
      machineEnabled,
      nodeId,
      channel,
      credentialHash,
      iot: parsedIot,
      now,
    }));
    selfIotNodeId = nodeId;
    syncNodes.add(nodeId);
    iotChanged = true;
    next.set("iot", { config: parsedIot, secrets: {}, credentialHash: null });
  } else if (iotBefore) {
    // Keep node name / enabled synced when machine metadata changes.
    const existingNode = await getNode(c.env.DB, shopId, iotBefore.nodeId).catch(() => null);
    if (existingNode) {
      nodeStatements.push(await iotNodeSyncStatement(c.env.DB, {
        shopId,
        machineName,
        machineEnabled,
        nodeId: iotBefore.nodeId,
        channel: existingNode.channel,
        credentialHash: null,
        iot: iotBefore,
        now,
      }));
      syncNodes.add(iotBefore.nodeId);
    }
  }

  // --- Host (PRiSM Launcher) capability (`host`) — auto-managed 1:1 `ln_<id>` node ---
  const hostBefore = stored.get("host")?.config as HostConfig | undefined;
  let hostToken: string | null = null;

  if (body.host === null) {
    if (hostBefore?.nodeId) {
      if (hostBefore.nodeId === `ln_${machineId}`) {
        nodeStatements.push(c.env.DB.prepare(
          "DELETE FROM shop_nodes WHERE shop_id=? AND id=? AND kind='launcher'",
        ).bind(shopId, hostBefore.nodeId));
      } else {
        syncNodes.add(hostBefore.nodeId);
      }
    }
    next.delete("host");
  } else if (body.host !== undefined || (body.rotateHostToken && hostBefore)) {
    const nodeId = body.host?.nodeId ?? hostBefore?.nodeId ?? `ln_${machineId}`;
    const existingNode = await getNode(c.env.DB, shopId, nodeId).catch(() => null);
    if (body.host?.nodeId && (!existingNode || existingNode.kind !== "launcher")) {
      jsonError(404, "绑定的 Launcher 节点不存在", "NODE_NOT_FOUND");
    }
    const programs = body.host?.programs ?? hostBefore?.programs ?? [];
    const defaultProgram = body.host?.defaultProgram !== undefined
      ? body.host.defaultProgram
      : body.host?.default !== undefined
        ? body.host.default
        : hostBefore?.defaultProgram ?? null;
    const parsedHost = capabilities.host.config.safeParse({
      nodeId,
      defaultProgram,
      programs,
    });
    if (!parsedHost.success) jsonError(422, "主机启动配置无效", "INVALID_HOST_CONFIG");
    let credentialHash: string | null = null;
    if (body.rotateHostToken) {
      hostToken = mintNodeToken("launcher");
      credentialHash = await hashNodeToken(hostToken);
    }
    const channel = existingNode?.channel ?? mintNodeChannel("launcher");
    nodeStatements.push(await launcherNodeSyncStatement(c.env.DB, {
      shopId,
      machineName,
      machineEnabled,
      nodeId,
      channel,
      credentialHash,
      now,
    }));
    if (hostBefore?.nodeId && hostBefore.nodeId !== nodeId) syncNodes.add(hostBefore.nodeId);
    syncNodes.add(nodeId);
    next.set("host", { config: parsedHost.data, secrets: {}, credentialHash: null });
  } else if (hostBefore) {
    const existingNode = await getNode(c.env.DB, shopId, hostBefore.nodeId).catch(() => null);
    if (existingNode) {
      nodeStatements.push(await launcherNodeSyncStatement(c.env.DB, {
        shopId,
        machineName,
        machineEnabled,
        nodeId: hostBefore.nodeId,
        channel: existingNode.channel,
        credentialHash: null,
        now,
      }));
    }
  }

  // --- HINATA IO capability (`hinata_io`) ---
  const io = stored.get("hinata_io");
  const beforeIo = io?.config as Partial<HinataConfig> | undefined;
  const secrets = { ...io?.secrets };
  if (body.hinataUrl !== undefined) {
    if (body.hinataUrl) secrets.url = await seal(body.hinataUrl); else delete secrets.url;
  }
  if (body.hinataPassword !== undefined) {
    if (body.hinataPassword) secrets.password = await seal(body.hinataPassword); else delete secrets.password;
  }
  const transport = body.relayConnection ?? (body.hinataNodeId ? "embedded" : undefined) ?? beforeIo?.transport ?? "external";
  let relayToken: string | null = null;
  if (transport === "embedded") {
    if (body.hinataPassword) jsonError(400, "直连模式需要清空机台的 remotePassword", "DEVICE_RELAY_PASSWORD_CONFLICT");
    delete secrets.password;
    let nodeId = body.hinataNodeId ?? beforeIo?.nodeId ?? `io_${machineId}`;
    let channel = beforeIo?.channel ?? `m_${randomToken(16)}`;
    let credentialHash: string | null = null;
    if (body.hinataNodeId) {
      const boundNode = await getNode(c.env.DB, shopId, body.hinataNodeId);
      if (!boundNode || boundNode.kind !== "hinata_io") jsonError(404, "绑定的 HINATA IO 节点不存在", "NODE_NOT_FOUND");
      nodeId = boundNode.id;
      channel = boundNode.channel;
      if (body.rotateRelayToken || !boundNode.hasToken) {
        relayToken = `prism_io_${randomToken(32)}`;
        credentialHash = await sha256Hex(relayToken);
        nodeStatements.push(await hinataNodeSyncStatement(c.env.DB, {
          shopId, machineId, machineName: boundNode.name, machineEnabled, nodeId, channel, credentialHash, now,
        }));
      }
    } else {
      const existingNode = await getNode(c.env.DB, shopId, nodeId).catch(() => null);
      if (existingNode) channel = existingNode.channel;
      const hasExistingHash = !!existingNode?.hasToken || (beforeIo?.transport === "embedded" && !!io?.credentialHash);
      if (body.rotateRelayToken || !hasExistingHash) {
        relayToken = `prism_io_${randomToken(32)}`;
        credentialHash = await sha256Hex(relayToken);
      } else if (!existingNode && io?.credentialHash) {
        credentialHash = io.credentialHash;
      }
      nodeStatements.push(await hinataNodeSyncStatement(c.env.DB, {
        shopId, machineId, machineName, machineEnabled, nodeId, channel, credentialHash, now,
      }));
    }
    next.set("hinata_io", { config: { transport, keys: [], nodeId, channel }, secrets, credentialHash: null });
  } else {
    if (beforeIo?.transport === "embedded" && (!beforeIo.nodeId || beforeIo.nodeId === `io_${machineId}`)) {
      nodeStatements.push(c.env.DB.prepare(
        "DELETE FROM shop_nodes WHERE shop_id=? AND id=? AND kind='hinata_io'",
      ).bind(shopId, `io_${machineId}`));
    }
    if (secrets.url) {
      next.set("hinata_io", { config: { transport, keys: [] }, secrets, credentialHash: null });
    } else {
      next.delete("hinata_io");
    }
  }

  // --- Unified cabinet buttons (`keys`) ---
  const keysBefore = stored.get("keys")?.config as KeysConfig | undefined;
  const resolveIotRef = (ref: string | null | undefined): string | null => {
    if (!ref) return null;
    if (ref === SELF_IOT_REF) {
      if (!selfIotNodeId) jsonError(422, "请先启用本资源的 IoT 控制器能力", "NODE_NOT_FOUND");
      return selfIotNodeId;
    }
    return ref;
  };

  // Track old GPIO nodes so removed pins get pushed via `syncNodeConfig`.
  for (const oldBtn of keysBefore?.buttons ?? []) {
    if (oldBtn.mode === "gpio") syncNodes.add(oldBtn.nodeId);
  }
  const coinBefore = stored.get("coin")?.config as CoinConfig | undefined;
  if (coinBefore?.feedbackNodeId) syncNodes.add(coinBefore.feedbackNodeId);

  let buttons: ResourceButton[] | null = null;
  if (body.keys === null) {
    buttons = null;
    next.delete("keys");
  } else if (body.keys !== undefined) {
    const parsedButtons: ResourceButton[] = body.keys.map((one) => {
      if (one.mode === "gpio") {
        const nodeId = resolveIotRef(one.nodeId);
        if (!nodeId) jsonError(422, `请为按键「${one.name}」选择 IoT 控制器`, "NODE_NOT_FOUND");
        return {
          id: one.id ?? randomToken(8),
          name: one.name,
          mode: "gpio",
          nodeId,
          pin: one.pin,
          pulseMs: one.pulseMs ?? 80,
          activeLow: one.activeLow ?? true,
        };
      }
      const code = typeof one.key === "number" ? one.key : vkFromKeyText(one.key);
      if (code === null || code < 1 || code > 65535) jsonError(400, `无法识别「${one.name}」的按键`, "INVALID_KEY");
      return { id: one.id ?? randomToken(8), name: one.name, mode: "keyboard", key: code };
    });
    if (new Set(parsedButtons.map((one) => one.id)).size !== parsedButtons.length) {
      jsonError(400, "按键重复", "DUPLICATE_KEY");
    }
    buttons = parsedButtons;
    if (parsedButtons.length > 0 || body.keysEnabled === true || stored.has("keys") || !!body.coin) {
      next.set("keys", { config: { buttons: parsedButtons }, secrets: {}, credentialHash: null });
    } else {
      next.delete("keys");
    }
  } else if (keysBefore) {
    buttons = keysBefore.buttons;
  } else if (beforeIo?.keys?.length) {
    // Carry over legacy `hinata_io.keys` into `keys` when editing another field.
    buttons = beforeIo.keys.map((k) => ({ id: k.id, name: k.name, mode: "keyboard" as const, key: k.key }));
    next.set("keys", { config: { buttons }, secrets: {}, credentialHash: null });
  }

  // --- Coin capability (`coin`) ---
  let coinNext: CoinConfig | null | undefined = undefined;
  if (body.coin === null) {
    coinNext = null;
  } else if (body.coin !== undefined) {
    // Support legacy GPIO coin payloads by auto-adding a GPIO button to `keys`.
    if (body.coin.method === "gpio" && body.coin.nodeId && body.coin.pin != null) {
      const nodeId = resolveIotRef(body.coin.nodeId)!;
      const list = buttons ?? [];
      const existingCoinBtn = list.find((b) => b.id === "coin");
      const coinBtn: ResourceButton = {
        id: existingCoinBtn?.id ?? "coin",
        name: existingCoinBtn?.name ?? "投币",
        mode: "gpio",
        nodeId,
        pin: body.coin.pin,
        pulseMs: body.coin.pulseMs ?? 80,
        activeLow: body.coin.activeLow ?? true,
      };
      buttons = existingCoinBtn ? list.map((b) => (b.id === coinBtn.id ? coinBtn : b)) : [...list, coinBtn];
      next.set("keys", { config: { buttons }, secrets: {}, credentialHash: null });
      coinNext = capabilities.coin.config.parse({
        keyId: coinBtn.id,
        cap: null,
        afterSwipe: false,
        feedbackNodeId: body.coin.feedbackPin != null ? nodeId : null,
        feedbackPin: body.coin.feedbackPin ?? null,
        feedbackEdge: body.coin.feedbackEdge ?? "falling",
        feedbackDebounceMs: body.coin.feedbackDebounceMs ?? 50,
        feedbackSignal: body.coin.feedbackSignal ?? "cabinet.coin",
      });
    } else {
      const chosenKeyId = body.coin.keyId ?? null;
      const chosenBtn = chosenKeyId ? (buttons ?? []).find((b) => b.id === chosenKeyId) : undefined;
      const allowFeedback = chosenBtn?.mode === "gpio";
      const feedbackPin = allowFeedback ? (body.coin.feedbackPin ?? null) : null;
      const feedbackNodeId = feedbackPin !== null ? resolveIotRef(body.coin.feedbackNodeId ?? null) : null;
      if (feedbackPin !== null && !feedbackNodeId) {
        jsonError(422, "配置硬件回报引脚时请选择 IoT 控制器", "INVALID_COIN_GPIO");
      }
      coinNext = capabilities.coin.config.parse({
        keyId: chosenKeyId,
        cap: body.coin.cap ?? null,
        afterSwipe: body.coin.afterSwipe ?? false,
        feedbackNodeId,
        feedbackPin,
        feedbackEdge: body.coin.feedbackEdge ?? "falling",
        feedbackDebounceMs: body.coin.feedbackDebounceMs ?? 50,
        feedbackSignal: body.coin.feedbackSignal ?? "cabinet.coin",
      });
    }
  } else if (body.coinKey !== undefined) {
    if (body.coinKey === 0) {
      coinNext = null;
    } else {
      const list = buttons ?? [];
      const keyId = body.coinKeyId ?? list.find((one) => one.mode === "keyboard" && one.key === body.coinKey)?.id ?? "coin";
      if (!list.some((one) => one.id === keyId)) {
        buttons = [...list, { id: keyId, name: "投币", mode: "keyboard", key: body.coinKey }];
        next.set("keys", { config: { buttons }, secrets: {}, credentialHash: null });
      }
      coinNext = capabilities.coin.config.parse({
        keyId,
        cap: body.coinCap ?? coinBefore?.cap ?? null,
        afterSwipe: body.coinAfterSwipe ?? coinBefore?.afterSwipe ?? false,
      });
    }
  } else if (coinBefore && (body.coinCap !== undefined || body.coinAfterSwipe !== undefined || body.coinKeyId !== undefined)) {
    coinNext = {
      ...coinBefore,
      ...(body.coinCap !== undefined ? { cap: body.coinCap } : {}),
      ...(body.coinAfterSwipe !== undefined ? { afterSwipe: body.coinAfterSwipe } : {}),
      ...(body.coinKeyId !== undefined ? { keyId: body.coinKeyId } : {}),
    };
  } else {
    coinNext = coinBefore ?? null;
  }

  if (coinNext) {
    const activeButtons = (next.get("keys")?.config as KeysConfig | undefined)?.buttons ?? [];
    const chosen = coinNext.keyId ? activeButtons.find((one) => one.id === coinNext!.keyId) : null;
    const keyId = chosen ? chosen.id : null;
    const directIo = next.get("hinata_io")?.config.transport === "embedded";
    const cap = directIo ? coinNext.cap : null;
    const afterSwipe = directIo && cap != null && !!keyId && coinNext.afterSwipe;
    next.set("coin", {
      config: { ...coinNext, keyId, cap, afterSwipe },
      secrets: {},
      credentialHash: null,
    });
    if (coinNext.feedbackNodeId) syncNodes.add(coinNext.feedbackNodeId);
  } else {
    next.delete("coin");
  }

  // --- Validate all referenced IoT nodes & GPIO pin conflicts across `keys` and `coin` ---
  const pinsByNode = new Map<string, number[]>();
  const addPin = (nodeId: string, pin: number) => {
    const list = pinsByNode.get(nodeId) ?? [];
    list.push(pin);
    pinsByNode.set(nodeId, list);
  };
  const finalButtons = (next.get("keys")?.config as KeysConfig | undefined)?.buttons ?? [];
  for (const btn of finalButtons) {
    if (btn.mode === "gpio") {
      addPin(btn.nodeId, btn.pin);
      syncNodes.add(btn.nodeId);
    }
  }
  const finalCoin = next.get("coin")?.config as CoinConfig | undefined;
  if (finalCoin?.feedbackNodeId && finalCoin.feedbackPin !== null) {
    addPin(finalCoin.feedbackNodeId, finalCoin.feedbackPin);
    syncNodes.add(finalCoin.feedbackNodeId);
  }
  for (const [nodeId, pins] of pinsByNode) {
    if (nodeId !== selfIotNodeId) {
      const iotNode = await getNode(c.env.DB, shopId, nodeId);
      if (!iotNode || iotNode.kind !== "iot") {
        jsonError(404, "绑定的 IoT 控制器不存在", "NODE_NOT_FOUND");
      }
    }
    const clash = await validateNodePinConflicts(c.env.DB, shopId, machineId, nodeId, pins);
    if (clash) jsonError(409, clash, "GPIO_PIN_CONFLICT");
  }

  return { next, relayToken, hostToken, iotToken, connections, nodeStatements, syncNodes, iotChanged, selfIotNodeId };
}

async function nextBot(
  c: C, shopId: string, stored: ReadonlyMap<CapabilityId, StoredCapability>,
  next: Map<CapabilityId, StoredCapability>, body: MachineInput, name: string,
) {
  const before = stored.get("bot")?.config as BotConfig | undefined;
  const statements: D1BoundStatementLike[] = [];
  const now = new Date().toISOString();
  const revoke = (tokenId: string) => statements.push(c.env.DB.prepare(
    "UPDATE api_tokens SET status='revoked',revoked_at=? WHERE shop_id=? AND id=? AND status='active'",
  ).bind(now, shopId, tokenId));
  if (body.bot === null) {
    next.delete("bot");
    if (before) revoke(before.tokenId);
    return { statements, token: null as string | null };
  }
  if (body.bot === undefined && !body.rotateBotToken) return { statements, token: null as string | null };
  if (!before && body.bot === undefined) return { statements, token: null as string | null };
  if (body.bot?.doorResourceId) {
    const door = await c.env.DB.prepare(
      "SELECT 1 FROM device_capabilities WHERE shop_id=? AND device_id=? AND capability='door'",
    ).bind(shopId, body.bot.doorResourceId).first();
    if (!door) jsonError(400, "请选择有门锁能力的资源", "BOT_DOOR_INVALID");
  }
  let tokenId = before?.tokenId;
  let token: string | null = null;
  if (!tokenId || body.rotateBotToken) {
    token = `prism_integration_${randomToken(32)}`;
    if (tokenId) revoke(tokenId);
    tokenId = crypto.randomUUID();
    statements.push(c.env.DB.prepare(
      "INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,?,?,'integration','prism_integration',?,'active',?)",
    ).bind(shopId, tokenId, name, await sha256Hex(token), now));
  }
  const config = capabilities.bot.config.parse({ ...before, ...body.bot, tokenId });
  next.set("bot", { config, secrets: {}, credentialHash: null });
  return { statements, token };
}

async function nextBinding(c: C, shopId: string, machineId: string | null, body: MachineInput) {
  const stored = machineId
    ? await c.env.DB.prepare(
      "SELECT resource_group_id AS groupId,pricing_config_override_id AS overrideId,capacity,occupancy_minutes AS occupancyMinutes FROM machines WHERE id=? AND shop_id=?",
    ).bind(machineId, shopId).first<{ groupId: string | null; overrideId: string | null; capacity: number; occupancyMinutes: number }>()
    : null;
  const requested = body.resourceGroupId === DEFAULT_RESOURCE_GROUP_ID ? null : body.resourceGroupId;
  const groupId = requested === undefined ? stored?.groupId ?? null : requested;
  const overrideId = body.pricingConfigOverrideId === undefined ? stored?.overrideId ?? null : body.pricingConfigOverrideId;
  if (requested && !await findResourceGroup(c.env.DB, shopId, requested))
    jsonError(400, "请选择有效的资源组", "RESOURCE_GROUP_NOT_FOUND");
  if (body.pricingConfigOverrideId) await assertBillablePlan(c, shopId, body.pricingConfigOverrideId);
  return {
    groupId, overrideId,
    capacity: body.capacity ?? stored?.capacity ?? null,
    occupancyMinutes: body.occupancyMinutes ?? stored?.occupancyMinutes ?? 15,
  };
}

async function changeResource(c: C, machineId?: string) {
  const user = requireUser(c);
  const raw = await c.req.json();
  const body: MachineInput = machineId ? patchInput.parse(raw) : machineInput.parse(raw);
  const located = machineId
    ? await c.env.DB.prepare("SELECT shop_id FROM machines WHERE id=?").bind(machineId).first<{ shop_id: string }>()
    : null;
  if (machineId && !located) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  const shopId = located?.shop_id ?? body.shopId;
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  if (!await canConfigureResource(c, user, shopId))
    jsonError(403, "只读账号不能配置资源", "FORBIDDEN");
  if (body.shopId && body.shopId !== shopId)
    jsonError(400, "资源不能移动到其他店铺", "DEVICE_SHOP_IMMUTABLE");
  const publicShopId = await shopPublicId(c, shopId);
  const current = machineId ? await loadResource(c.env.DB, shopId, machineId) : null;

  await validateTable(c, shopId, current, body);
  const binding = await nextBinding(c, shopId, machineId ?? null, body);
  const id = current?.id ?? crypto.randomUUID();
  const name = body.name ?? current?.name;
  if (!name) jsonError(400, "资源名称不能为空", "INVALID_DEVICE_NAME");
  const enabled = +(body.enabled ?? current?.enabled ?? true);
  const stored = current ? await storedCapabilities(c.env.DB, shopId, id) : new Map<CapabilityId, StoredCapability>();
  const {
    next,
    relayToken,
    hostToken,
    iotToken,
    connections,
    nodeStatements,
    syncNodes,
    iotChanged,
    selfIotNodeId,
  } = await nextCapabilities(c, shopId, id, name, enabled === 1, stored, body);
  const bot = await nextBot(c, shopId, stored, next, body, name);

  // Enforce declarative capability conflicts & dependencies.
  const capError = validateCapabilitySet(next.keys());
  if (capError) {
    jsonError(capError.code === "CAPABILITY_CONFLICT" ? 409 : 422, capError.message, capError.code);
  }

  // Optional resource-level location verification override.
  const locationStatements: D1BoundStatementLike[] = [];
  if (body.locationOverride !== undefined) {
    const existingLoc = await readShopLocationSettings(c.env.DB, shopId);
    let override = body.locationOverride;
    if (override && override.mode === "ble" && override.beaconNodeId) {
      const resolvedBeacon = override.beaconNodeId === SELF_IOT_REF ? selfIotNodeId : override.beaconNodeId;
      if (!resolvedBeacon) jsonError(422, "请先启用本资源的 IoT 控制器能力", "NODE_NOT_FOUND");
      if (resolvedBeacon !== selfIotNodeId) {
        const node = await getNode(c.env.DB, shopId, resolvedBeacon);
        if (!node || node.kind !== "iot") jsonError(404, "指定的蓝牙信标控制器不存在", "NODE_NOT_FOUND");
      }
      override = { ...override, beaconNodeId: resolvedBeacon };
    }
    const updatedLoc = withResourceLocationOverride(existingLoc, id, override);
    locationStatements.push(writeShopLocationSettingsStatement(c.env.DB, shopId, updatedLoc));
  }

  const capacity = binding.capacity ?? (next.has("table") ? 4 : (next.has("hinata_io") || next.has("coin")) ? 1 : 0);
  if (next.has("table") && (capacity < 2 || capacity > 8)) jsonError(400, "桌游容量须为 2 到 8 人", "TABLE_CAPACITY_INVALID");
  if (current && next.has("table") && capacity !== current.capacity && await tableSeated(c, current))
    jsonError(409, "请先让玩家下桌再修改桌游配置", "TABLE_IN_USE");
  const aliases = [...new Set((body.aliases ?? current?.aliases ?? []).map((x) => x.trim()).filter(Boolean))];
  const kind = body.kind ?? current?.kind ?? "machine";
  const identity = current
    ? c.env.DB.prepare(
      `UPDATE machines SET name=?,enabled=?,kind=?,aliases_json=?,resource_group_id=?,pricing_config_override_id=?,
         capacity=?,occupancy_minutes=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND shop_id=?`,
    ).bind(name, enabled, kind, JSON.stringify(aliases), binding.groupId, binding.overrideId, capacity, binding.occupancyMinutes, id, shopId)
    : c.env.DB.prepare(
      `INSERT INTO machines(id,public_id,shop_id,name,enabled,kind,aliases_json,hinata_url_encrypted,resource_group_id,pricing_config_override_id,capacity,occupancy_minutes)
       VALUES (?,?,?,?,?,?,?,'',?,?,?,?)`,
    ).bind(id, randomToken(12), shopId, name, enabled, kind, JSON.stringify(aliases), binding.groupId, binding.overrideId, capacity, binding.occupancyMinutes);
  const write = () => c.env.DB.batch([
    identity,
    ...connections.map((connection) => writeHaConnection(c.env.DB, shopId, connection)),
    ...nodeStatements,
    ...capabilityWrites(c.env.DB, { shopId, deviceId: id, next, now: new Date() }),
    ...bot.statements,
    ...locationStatements,
  ]);
  // Changing an existing resource's plan or its table's game plan is a price change.
  if (current && (body.pricingConfigOverrideId !== undefined || body.table !== undefined)) {
    await recordBindingEdit(c.env.DB, shopId, user.id, write);
  } else {
    await write();
  }
  for (const nodeId of syncNodes) await syncNodeConfig(c.env.DB, c.env, shopId, nodeId);
  if (iotChanged) await refreshShopHub(c.env, shopId).catch(() => {});
  // Bots are told the shop's tables and doors, and each its own settings.
  notifyBotsChangedAfter(c, shopId);
  // A new Home Assistant gets its read-only account in the background; a failure
  // is recorded on the connection and shown on the board, never on this save.
  for (const connection of connections) scheduleReadAccess(c, shopId, connection.id);
  afterHaChange(c, shopId);
  const updated = await loadResource(c.env.DB, shopId, id);
  if (!updated) jsonError(500, "资源保存失败", "DEVICE_SAVE_FAILED");
  const [machine] = await presentWithStatus(c, [updated], publicShopId, true);
  const wsUrl = nodeEndpointWsUrl(c);
  return c.json({
    machine,
    // Returned exactly once, here. Reloading the device list never re-exposes them.
    ...(relayToken ? { relayToken } : {}),
    ...(hostToken ? { hostToken, hostWsUrl: wsUrl } : {}),
    ...(iotToken ? { iotToken, iotWsUrl: wsUrl } : {}),
    ...(bot.token ? { botToken: bot.token } : {}),
  }, current ? 200 : 201);
}

merchantResourceRouter.post("/machines", (c) => changeResource(c));
merchantResourceRouter.patch("/machines/:id", (c) => changeResource(c, c.req.param("id")));
merchantResourceRouter.delete("/machines/:id", async (c) => {
  const user = requireUser(c), id = c.req.param("id");
  const machine = await c.env.DB.prepare(
    "SELECT id,shop_id FROM machines WHERE id=?",
  ).bind(id).first<{ id: string; shop_id: string }>();
  if (!machine) jsonError(404, "没有找到这个资源", "DEVICE_NOT_FOUND");
  await assertResourceShop(c, user, machine.shop_id);
  if (!await canConfigureResource(c, user, machine.shop_id))
    jsonError(403, "只读账号不能配置资源", "FORBIDDEN");
  const used = await c.env.DB.prepare(
    `SELECT 1 FROM machine_login_events WHERE machine_id=?
     UNION ALL SELECT 1 FROM player_operations WHERE device_id=?
     UNION ALL SELECT 1 FROM device_operations WHERE shop_id=? AND device_id=?
     UNION ALL SELECT 1 FROM resource_occupancies WHERE shop_id=? AND resource_id=?
     UNION ALL SELECT 1 FROM table_seats WHERE shop_id=? AND machine_id=? LIMIT 1`,
  ).bind(id, id, machine.shop_id, id, machine.shop_id, id, machine.shop_id, id).first();
  if (used) jsonError(409, "资源已有使用记录，请改为停用", "MACHINE_HAS_HISTORY");
  const priorCaps = await storedCapabilities(c.env.DB, machine.shop_id, id);

  // Guard deleting a resource whose IoT controller is referenced by other resources.
  const priorIot = priorCaps.get("iot")?.config as IotConfig | undefined;
  if (priorIot?.nodeId) {
    const refs = await findExternalIotReferrers(c, machine.shop_id, id, priorIot.nodeId);
    if (refs.length) {
      jsonError(409, `该资源的 IoT 控制器仍被「${refs.join("、")}」引用，请先解除引用后再删除`, "NODE_IN_USE");
    }
  }

  const botToken = await c.env.DB.prepare(
    "SELECT json_extract(config_json,'$.tokenId') AS tokenId FROM device_capabilities WHERE shop_id=? AND device_id=? AND capability='bot'",
  ).bind(machine.shop_id, id).first<{ tokenId: string | null }>();

  const existingLoc = await readShopLocationSettings(c.env.DB, machine.shop_id);
  const locCleanup = id in existingLoc.resources
    ? [writeShopLocationSettingsStatement(c.env.DB, machine.shop_id, withResourceLocationOverride(existingLoc, id, null))]
    : [];

  await c.env.DB.batch([
    ...(botToken?.tokenId ? [c.env.DB.prepare(
      "UPDATE api_tokens SET status='revoked',revoked_at=? WHERE shop_id=? AND id=? AND status='active'",
    ).bind(new Date().toISOString(), machine.shop_id, botToken.tokenId)] : []),
    c.env.DB.prepare("DELETE FROM machine_tickets WHERE machine_id=?").bind(id),
    c.env.DB.prepare("DELETE FROM device_capabilities WHERE shop_id=? AND device_id=?").bind(machine.shop_id, id),
    c.env.DB.prepare("DELETE FROM device_events WHERE shop_id=? AND device_id=?").bind(machine.shop_id, id),
    c.env.DB.prepare("DELETE FROM device_state WHERE shop_id=? AND device_id=?").bind(machine.shop_id, id),
    c.env.DB.prepare("DELETE FROM machines WHERE id=? AND shop_id=?").bind(id, machine.shop_id),
    // Remove auto-owned 1:1 edge nodes belonging to this resource.
    c.env.DB.prepare("DELETE FROM shop_nodes WHERE shop_id=? AND id=? AND kind='hinata_io'").bind(machine.shop_id, `io_${id}`),
    c.env.DB.prepare("DELETE FROM shop_nodes WHERE shop_id=? AND id=? AND kind='launcher'").bind(machine.shop_id, `ln_${id}`),
    c.env.DB.prepare("DELETE FROM shop_nodes WHERE shop_id=? AND id=? AND kind='iot'").bind(machine.shop_id, `iot_${id}`),
    ...locCleanup,
  ]);

  const syncAfterDelete = new Set<string>();
  const oldHost = priorCaps.get("host")?.config as HostConfig | undefined;
  if (oldHost?.nodeId && oldHost.nodeId !== `ln_${id}`) syncAfterDelete.add(oldHost.nodeId);
  const oldKeys = priorCaps.get("keys")?.config as KeysConfig | undefined;
  for (const btn of oldKeys?.buttons ?? []) {
    if (btn.mode === "gpio" && btn.nodeId !== `iot_${id}`) syncAfterDelete.add(btn.nodeId);
  }
  const oldCoin = priorCaps.get("coin")?.config as CoinConfig | undefined;
  if (oldCoin?.feedbackNodeId && oldCoin.feedbackNodeId !== `iot_${id}`) syncAfterDelete.add(oldCoin.feedbackNodeId);
  for (const nodeId of syncAfterDelete) await syncNodeConfig(c.env.DB, c.env, machine.shop_id, nodeId);
  if (priorIot) await refreshShopHub(c.env, machine.shop_id).catch(() => {});
  notifyBotsChangedAfter(c, machine.shop_id);
  afterHaChange(c, machine.shop_id);
  return c.json({ ok: true });
});
