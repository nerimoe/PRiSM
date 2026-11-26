/**
 * Shop-level edge nodes (`shop_nodes`): HINATA IO, PRiSM Launcher, and IoT controllers.
 *
 * Every edge node owns its own identity, credential hash, Durable Object
 * channel, and node-level configuration. Resources own their `hinata_io`,
 * `host`, or `iot` capability (synchronizing 1:1 with `shop_nodes`), while any
 * resource's `keys` (GPIO buttons) or `coin` (GPIO feedback) can reference any
 * shop IoT controller by `nodeId`. The server derives each node's runtime
 * configuration (`node.setConfig`) from those bindings so edge firmware/clients
 * only ever need `url` + `token`.
 */
import type { D1BoundStatementLike, D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import { randomToken, sha256Hex } from "../crypto.js";
import { machineRelayNamespace } from "../gateway/machine-relay-gateway.js";
import {
  parseNodeConfig,
  type IotInputPinConfig,
  type IotNodeConfig,
  type IotOutputPinConfig,
  type IotRuntimeConfig,
  type LauncherRuntimeConfig,
  type NodeConfig,
  type NodeKind,
  type NodeRuntimeConfig,
} from "../hardware/node-protocol.js";
import type { CoinConfig, HostConfig, IotConfig, KeysConfig } from "./capabilities/catalog.js";
import { logger } from "../log.js";

const log = logger("shop-nodes");

export type ShopNode<K extends NodeKind = NodeKind> = {
  shopId: string;
  id: string;
  kind: K;
  name: string;
  enabled: boolean;
  channel: string;
  hasToken: boolean;
  config: K extends "hinata_io"
    ? ReturnType<typeof parseNodeConfig<"hinata_io">>
    : K extends "launcher"
      ? ReturnType<typeof parseNodeConfig<"launcher">>
      : K extends "iot"
        ? ReturnType<typeof parseNodeConfig<"iot">>
        : NodeConfig;
  createdAt: string;
  updatedAt: string;
};

type ShopNodeRow = {
  shop_id: string;
  id: string;
  kind: string;
  name: string;
  enabled: number;
  channel: string;
  credential_hash: string | null;
  config_json: string;
  created_at: string;
  updated_at: string;
};

function parseJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function hydrateNode(row: ShopNodeRow): ShopNode | null {
  if (row.kind !== "hinata_io" && row.kind !== "launcher" && row.kind !== "iot") return null;
  const kind = row.kind as NodeKind;
  return {
    shopId: row.shop_id,
    id: row.id,
    kind,
    name: row.name,
    enabled: row.enabled === 1,
    channel: row.channel,
    hasToken: !!row.credential_hash,
    config: parseNodeConfig(kind, parseJson(row.config_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as ShopNode;
}

export async function listNodes(db: D1DatabaseLike, shopId: string, kind?: NodeKind): Promise<ShopNode[]> {
  const rows = kind
    ? (await db.prepare(
        "SELECT shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at FROM shop_nodes WHERE shop_id = ? AND kind = ? ORDER BY created_at, id",
      ).bind(shopId, kind).all<ShopNodeRow>()).results
    : (await db.prepare(
        "SELECT shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at FROM shop_nodes WHERE shop_id = ? ORDER BY created_at, id",
      ).bind(shopId).all<ShopNodeRow>()).results;
  return rows.map(hydrateNode).filter((node): node is ShopNode => node !== null);
}

export async function getNode(db: D1DatabaseLike, shopId: string, nodeId: string): Promise<ShopNode | null> {
  const row = await db
    .prepare(
      "SELECT shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at FROM shop_nodes WHERE shop_id = ? AND id = ?",
    )
    .bind(shopId, nodeId)
    .first<ShopNodeRow>();
  return row ? hydrateNode(row) : null;
}

export async function findNodeByChannel(db: D1DatabaseLike, channel: string): Promise<ShopNode | null> {
  const row = await db
    .prepare(
      "SELECT shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at FROM shop_nodes WHERE channel = ?",
    )
    .bind(channel)
    .first<ShopNodeRow>();
  return row ? hydrateNode(row) : null;
}

/** Resolve the Durable Object channel for a node id, falling back to a legacy stored channel. */
export async function resolveNodeChannel(
  db: D1DatabaseLike,
  shopId: string,
  nodeId: string | null | undefined,
  fallbackChannel?: string | null,
): Promise<{ nodeId: string | null; channel: string; enabled: boolean } | null> {
  if (nodeId) {
    const node = await getNode(db, shopId, nodeId);
    if (node) return { nodeId: node.id, channel: node.channel, enabled: node.enabled };
  }
  if (fallbackChannel) return { nodeId: nodeId ?? null, channel: fallbackChannel, enabled: true };
  return null;
}

/** Allocate the lowest unused BLE beacon id (1..65535) for an IoT node in this shop. */
export async function allocateBeaconId(db: D1DatabaseLike, shopId: string, excludeNodeId?: string): Promise<number> {
  const nodes = await listNodes(db, shopId, "iot");
  const used = new Set<number>();
  for (const node of nodes) {
    if (excludeNodeId && node.id === excludeNodeId) continue;
    const beaconId = (node.config as IotNodeConfig).ble.beaconId;
    if (typeof beaconId === "number") used.add(beaconId);
  }
  for (let id = 1; id <= 65535; id++) {
    if (!used.has(id)) return id;
  }
  throw new Error("店铺 BLE 信标编号已满");
}

export function mintNodeToken(kind: NodeKind): string {
  const prefix = kind === "hinata_io" ? "prism_io_" : kind === "launcher" ? "prism_ln_" : "prism_iot_";
  return `${prefix}${randomToken(32)}`;
}

export function mintNodeChannel(kind: NodeKind): string {
  const prefix = kind === "hinata_io" ? "m_" : kind === "launcher" ? "ln_" : "iot_";
  return `${prefix}${randomToken(16)}`;
}

async function upsertNodeStatement(
  db: D1DatabaseLike,
  input: {
    shopId: string;
    nodeId: string;
    kind: NodeKind;
    name: string;
    enabled: boolean;
    channel: string;
    credentialHash: string | null;
    config: NodeConfig;
    now: Date;
    preserveExistingName?: boolean;
  },
): Promise<D1BoundStatementLike> {
  const existing = await getNode(db, input.shopId, input.nodeId);
  const at = input.now.toISOString();
  const configJson = JSON.stringify(parseNodeConfig(input.kind, input.config));
  const resolvedName = input.preserveExistingName ? (existing?.name ?? input.name) : input.name;
  return db
    .prepare(
      `INSERT INTO shop_nodes (shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(shop_id, id) DO UPDATE SET
         name = excluded.name,
         enabled = excluded.enabled,
         channel = excluded.channel,
         config_json = excluded.config_json,
         credential_hash = COALESCE(excluded.credential_hash, shop_nodes.credential_hash),
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.shopId,
      input.nodeId,
      input.kind,
      resolvedName,
      input.enabled ? 1 : 0,
      existing?.channel ?? input.channel,
      input.credentialHash,
      configJson,
      existing?.createdAt ?? at,
      at,
    );
}

/**
 * Keep a direct-connected `hinata_io` capability synchronized with its `shop_nodes` row.
 */
export async function hinataNodeSyncStatement(
  db: D1DatabaseLike,
  input: {
    shopId: string;
    machineId: string;
    machineName: string;
    machineEnabled: boolean;
    nodeId: string;
    channel: string;
    credentialHash: string | null;
    now: Date;
  },
): Promise<D1BoundStatementLike> {
  const existing = await getNode(db, input.shopId, input.nodeId);
  return upsertNodeStatement(db, {
    shopId: input.shopId,
    nodeId: input.nodeId,
    kind: "hinata_io",
    name: input.machineName,
    enabled: input.machineEnabled,
    channel: input.channel,
    credentialHash: input.credentialHash,
    config: existing ? existing.config : parseNodeConfig("hinata_io", {}),
    now: input.now,
    preserveExistingName: true,
  });
}

/** Keep a resource's `host` (PRiSM Launcher) capability synchronized with its `shop_nodes` row. */
export async function launcherNodeSyncStatement(
  db: D1DatabaseLike,
  input: {
    shopId: string;
    machineName: string;
    machineEnabled: boolean;
    nodeId: string;
    channel: string;
    credentialHash: string | null;
    now: Date;
  },
): Promise<D1BoundStatementLike> {
  const existing = await getNode(db, input.shopId, input.nodeId);
  return upsertNodeStatement(db, {
    shopId: input.shopId,
    nodeId: input.nodeId,
    kind: "launcher",
    name: input.machineName,
    enabled: input.machineEnabled,
    channel: existing?.channel ?? input.channel,
    credentialHash: input.credentialHash,
    config: existing ? existing.config : parseNodeConfig("launcher", {}),
    now: input.now,
  });
}

/** Keep a resource's `iot` controller capability synchronized with its `shop_nodes` row. */
export async function iotNodeSyncStatement(
  db: D1DatabaseLike,
  input: {
    shopId: string;
    machineName: string;
    machineEnabled: boolean;
    nodeId: string;
    channel: string;
    credentialHash: string | null;
    iot: Pick<IotConfig, "haWatch" | "ble">;
    now: Date;
  },
): Promise<D1BoundStatementLike> {
  const existing = await getNode(db, input.shopId, input.nodeId);
  return upsertNodeStatement(db, {
    shopId: input.shopId,
    nodeId: input.nodeId,
    kind: "iot",
    name: input.machineName,
    enabled: input.machineEnabled,
    channel: existing?.channel ?? input.channel,
    credentialHash: input.credentialHash,
    config: parseNodeConfig("iot", {
      haWatch: input.iot.haWatch,
      ble: {
        enabled: input.iot.ble.enabled,
        beaconId: input.iot.ble.beaconId,
        txPower: input.iot.ble.txPower,
      },
    }),
    now: input.now,
  });
}

export type NodeResourceBinding = {
  deviceId: string;
  deviceName: string;
  capability: "hinata_io" | "host" | "iot" | "keys" | "coin";
  pin?: number;
  direction?: "output" | "input";
  signal?: string;
  label?: string;
};

type CapRow = {
  device_id: string;
  device_name: string;
  enabled: number;
  capability: string;
  config_json: string;
};

async function shopCapabilityRows(db: D1DatabaseLike, shopId: string): Promise<CapRow[]> {
  return (
    await db
      .prepare(
        `SELECT c.device_id, m.name AS device_name, m.enabled, c.capability, c.config_json
         FROM device_capabilities c
         JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
         WHERE c.shop_id = ? AND c.capability IN ('hinata_io', 'host', 'iot', 'keys', 'coin')`,
      )
      .bind(shopId)
      .all<CapRow>()
  ).results;
}

/** Every resource binding referencing a node in this shop (for UI display and delete guards). */
export async function bindingsByNode(db: D1DatabaseLike, shopId: string): Promise<Map<string, NodeResourceBinding[]>> {
  const map = new Map<string, NodeResourceBinding[]>();
  const add = (nodeId: string, binding: NodeResourceBinding) => {
    const list = map.get(nodeId) ?? [];
    list.push(binding);
    map.set(nodeId, list);
  };
  for (const row of await shopCapabilityRows(db, shopId)) {
    const cfg = parseJson(row.config_json);
    if (row.capability === "hinata_io") {
      const nodeId = typeof cfg.nodeId === "string" ? cfg.nodeId : null;
      if (nodeId) add(nodeId, { deviceId: row.device_id, deviceName: row.device_name, capability: "hinata_io" });
    } else if (row.capability === "host") {
      const nodeId = typeof cfg.nodeId === "string" ? cfg.nodeId : null;
      if (nodeId) add(nodeId, { deviceId: row.device_id, deviceName: row.device_name, capability: "host" });
    } else if (row.capability === "iot") {
      const nodeId = typeof cfg.nodeId === "string" ? cfg.nodeId : null;
      if (nodeId) add(nodeId, { deviceId: row.device_id, deviceName: row.device_name, capability: "iot" });
    } else if (row.capability === "keys") {
      const buttons = Array.isArray(cfg.buttons) ? cfg.buttons : [];
      for (const rawBtn of buttons) {
        if (!rawBtn || typeof rawBtn !== "object") continue;
        const btn = rawBtn as { mode?: unknown; nodeId?: unknown; pin?: unknown; name?: unknown };
        if (btn.mode !== "gpio" || typeof btn.nodeId !== "string" || typeof btn.pin !== "number") continue;
        add(btn.nodeId, {
          deviceId: row.device_id,
          deviceName: row.device_name,
          capability: "keys",
          pin: btn.pin,
          direction: "output",
          ...(typeof btn.name === "string" ? { label: btn.name } : {}),
        });
      }
    } else if (row.capability === "coin") {
      // Current schema: `feedbackNodeId` + `feedbackPin`
      const feedbackNodeId =
        typeof cfg.feedbackNodeId === "string"
          ? cfg.feedbackNodeId
          : cfg.method === "gpio" && typeof cfg.nodeId === "string"
            ? cfg.nodeId
            : null;
      // Legacy GPIO coin output (pre-`keys` migration)
      if (cfg.method === "gpio" && typeof cfg.nodeId === "string" && typeof cfg.pin === "number") {
        add(cfg.nodeId, {
          deviceId: row.device_id,
          deviceName: row.device_name,
          capability: "coin",
          pin: cfg.pin,
          direction: "output",
          label: "投币",
        });
      }
      if (feedbackNodeId && typeof cfg.feedbackPin === "number") {
        add(feedbackNodeId, {
          deviceId: row.device_id,
          deviceName: row.device_name,
          capability: "coin",
          pin: cfg.feedbackPin,
          direction: "input",
          signal: typeof cfg.feedbackSignal === "string" ? cfg.feedbackSignal : "cabinet.coin",
        });
      }
    }
  }
  return map;
}

/**
 * Derive the complete runtime config to push to a node (`node.setConfig`).
 *
 * Single source of truth:
 * - `launcher`: programs & default program from the resource `host` capability bound to this node.
 * - `iot`: node's own BLE settings + every GPIO output (`keys`) and input (`coin` feedback) bound by enabled resources.
 */
export async function deriveNodeRuntimeConfig(
  db: D1DatabaseLike,
  shopId: string,
  node: ShopNode,
): Promise<NodeRuntimeConfig | null> {
  if (node.kind === "hinata_io") return null;

  const rows = (await shopCapabilityRows(db, shopId)).filter((r) => r.enabled === 1);

  if (node.kind === "launcher") {
    const match = rows.find((r) => r.capability === "host" && parseJson(r.config_json).nodeId === node.id);
    if (!match) return { default: null, programs: [] } satisfies LauncherRuntimeConfig;
    const cfg = parseJson(match.config_json) as Partial<HostConfig>;
    const allowedRoots = Array.isArray(cfg.allowedRoots)
      ? cfg.allowedRoots.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      : [];
    return {
      default: typeof cfg.defaultProgram === "string" ? cfg.defaultProgram : null,
      programs: Array.isArray(cfg.programs) ? cfg.programs : [],
      ...(allowedRoots.length ? { allowedRoots } : {}),
    } satisfies LauncherRuntimeConfig;
  }

  // IoT node: combine node-level BLE config with all bound GPIO outputs (`keys`) and inputs (`coin` feedback)
  const iotCfg = node.config as IotNodeConfig;
  const outputs = new Map<number, IotOutputPinConfig>();
  const inputs = new Map<number, IotInputPinConfig>();

  for (const row of rows) {
    if (row.capability === "keys") {
      const cfg = parseJson(row.config_json) as Partial<KeysConfig>;
      for (const btn of Array.isArray(cfg.buttons) ? cfg.buttons : []) {
        if (btn.mode !== "gpio" || btn.nodeId !== node.id) continue;
        outputs.set(btn.pin, {
          pin: btn.pin,
          activeLow: btn.activeLow !== false,
          defaultPulseMs: typeof btn.pulseMs === "number" ? btn.pulseMs : 80,
        });
      }
      continue;
    }
    if (row.capability === "coin") {
      const raw = parseJson(row.config_json);
      const cfg = raw as Partial<CoinConfig>;
      // Legacy GPIO output fallback
      if (raw.method === "gpio" && raw.nodeId === node.id && typeof raw.pin === "number" && !outputs.has(raw.pin)) {
        outputs.set(raw.pin, {
          pin: raw.pin,
          activeLow: raw.activeLow !== false,
          defaultPulseMs: typeof raw.pulseMs === "number" ? raw.pulseMs : 80,
        });
      }
      const feedbackNodeId =
        typeof cfg.feedbackNodeId === "string"
          ? cfg.feedbackNodeId
          : raw.method === "gpio" && typeof raw.nodeId === "string"
            ? raw.nodeId
            : null;
      if (feedbackNodeId === node.id && typeof cfg.feedbackPin === "number") {
        const edge = cfg.feedbackEdge === "rising" || cfg.feedbackEdge === "both" ? cfg.feedbackEdge : "falling";
        inputs.set(cfg.feedbackPin, {
          pin: cfg.feedbackPin,
          pull: edge === "rising" ? "down" : "up",
          edge,
          debounceMs: typeof cfg.feedbackDebounceMs === "number" ? cfg.feedbackDebounceMs : 50,
        });
      }
    }
  }

  return {
    ble: {
      enabled: iotCfg.ble.enabled && iotCfg.ble.beaconId !== null,
      beaconId: iotCfg.ble.beaconId,
      txPower: iotCfg.ble.txPower,
    },
    gpio: {
      outputs: [...outputs.values()].sort((a, b) => a.pin - b.pin),
      inputs: [...inputs.values()].sort((a, b) => a.pin - b.pin),
    },
  } satisfies IotRuntimeConfig;
}

export type GpioInputTarget = {
  deviceId: string;
  capability: "coin";
  signal: "cabinet.coin" | "cabinet.consumed" | "cabinet.activity";
};

/** Resolve which resource(s) own an incoming GPIO input pin event. */
export async function resolveGpioInputTargets(
  db: D1DatabaseLike,
  shopId: string,
  nodeId: string,
  pin: number,
): Promise<GpioInputTarget[]> {
  const rows = await db
    .prepare(
      `SELECT c.device_id, c.config_json
       FROM device_capabilities c
       JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
       WHERE c.shop_id = ? AND c.capability = 'coin' AND m.enabled = 1
         AND json_extract(c.config_json, '$.feedbackPin') = ?
         AND (
           json_extract(c.config_json, '$.feedbackNodeId') = ?
           OR (json_extract(c.config_json, '$.method') = 'gpio' AND json_extract(c.config_json, '$.nodeId') = ?)
         )`,
    )
    .bind(shopId, pin, nodeId, nodeId)
    .all<{ device_id: string; config_json: string }>();

  return rows.results.map((row) => {
    const cfg = parseJson(row.config_json);
    const sig = cfg.feedbackSignal;
    const signal: GpioInputTarget["signal"] =
      sig === "cabinet.consumed" || sig === "cabinet.activity" ? sig : "cabinet.coin";
    return { deviceId: row.device_id, capability: "coin", signal };
  });
}

/** Find the machine currently bound to a `hinata_io` node (by `nodeId` or legacy `channel`). */
export async function findHinataMachineForNode(
  db: D1DatabaseLike,
  shopId: string,
  nodeId: string,
  channel: string,
): Promise<{ deviceId: string; enabled: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT c.device_id, m.enabled
       FROM device_capabilities c
       JOIN machines m ON m.shop_id = c.shop_id AND m.id = c.device_id
       WHERE c.shop_id = ? AND c.capability = 'hinata_io'
         AND (json_extract(c.config_json, '$.nodeId') = ? OR json_extract(c.config_json, '$.channel') = ?)
       LIMIT 1`,
    )
    .bind(shopId, nodeId, channel)
    .first<{ device_id: string; enabled: number }>();
  return row ? { deviceId: row.device_id, enabled: row.enabled === 1 } : null;
}

/** Validate that the requested GPIO pins do not collide with any other resource or with each other. */
export async function validateNodePinConflicts(
  db: D1DatabaseLike,
  shopId: string,
  ignoreDeviceId: string | null,
  nodeId: string,
  pins: number[],
): Promise<string | null> {
  const unique = new Set(pins);
  if (unique.size !== pins.length) return "同一 IoT 控制器上不能重复使用相同的 GPIO 引脚";
  const byNode = await bindingsByNode(db, shopId);
  const existing = byNode.get(nodeId) ?? [];
  for (const pin of pins) {
    const clash = existing.find((b) => b.pin === pin && b.deviceId !== ignoreDeviceId);
    if (clash) return `GPIO ${pin} 已被「${clash.deviceName}」占用`;
  }
  return null;
}

/** Push freshly derived runtime configuration to an online node's Durable Object. */
export async function syncNodeConfig(
  db: D1DatabaseLike,
  env: Env,
  shopId: string,
  nodeId: string,
): Promise<void> {
  const relay = machineRelayNamespace(env);
  if (!relay) return;
  const node = await getNode(db, shopId, nodeId);
  if (!node || !node.enabled) return;
  const config = await deriveNodeRuntimeConfig(db, shopId, node);
  if (!config) return;
  try {
    await relay.getByName(node.channel).pushConfig(config);
  } catch (error) {
    log.warn(`could not push config to node ${nodeId}`, { shopId, nodeId, error });
  }
}

export type ShopBeaconEntry = {
  nodeId: string;
  nodeName: string;
  resourceId: string | null;
  beaconId: number;
  txPower: number;
  rssiThreshold: number;
};

/** Shop-wide BLE beacon directory derived from enabled IoT controllers. */
export async function listShopBeacons(db: D1DatabaseLike, shopId: string): Promise<ShopBeaconEntry[]> {
  const nodes = (await listNodes(db, shopId, "iot")).filter((n) => n.enabled);
  const iotRows = (await shopCapabilityRows(db, shopId)).filter((r) => r.enabled === 1 && r.capability === "iot");
  const ownerByNode = new Map<string, { resourceId: string; name: string; rssiThreshold: number }>();
  for (const row of iotRows) {
    const cfg = parseJson(row.config_json) as Partial<IotConfig>;
    if (typeof cfg.nodeId !== "string") continue;
    const rssi = typeof cfg.ble?.rssiThreshold === "number" ? cfg.ble.rssiThreshold : -75;
    ownerByNode.set(cfg.nodeId, { resourceId: row.device_id, name: row.device_name, rssiThreshold: rssi });
  }

  const beacons: ShopBeaconEntry[] = [];
  for (const node of nodes) {
    const ble = (node.config as IotNodeConfig).ble;
    if (!ble.enabled || ble.beaconId === null) continue;
    const owner = ownerByNode.get(node.id);
    beacons.push({
      nodeId: node.id,
      nodeName: owner?.name ?? node.name,
      resourceId: owner?.resourceId ?? null,
      beaconId: ble.beaconId,
      txPower: ble.txPower,
      rssiThreshold: owner?.rssiThreshold ?? -75,
    });
  }
  return beacons;
}

export async function hashNodeToken(token: string): Promise<string> {
  return sha256Hex(token);
}
