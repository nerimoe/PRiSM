/**
 * Shop-level edge nodes API (`/api/v1/merchant/nodes` & `/api/v1/merchant/beacons`).
 *
 * Manages HINATA IO, PRiSM Launcher, and dedicated IoT nodes under one unified model:
 * independent credentials, live WebSocket status, bound resource overview,
 * automatic BLE beacon id allocation, and server-driven `node.setConfig` push.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../bindings.js";
import { jsonError } from "../../http.js";
import { requireUser } from "../../middleware/auth.js";
import { machineRelayNamespace } from "../../gateway/machine-relay-gateway.js";
import { nodeRelayPath } from "../../gateway/relay-path.js";
import { refreshShopHub } from "../../durable-objects/shop-hub-client.js";
import {
  nodeKindSchema,
  parseNodeConfig,
  safeParseNodeConfig,
  type IotNodeConfig,
  type NodeKind,
} from "../../hardware/node-protocol.js";
import {
  allocateBeaconId,
  bindingsByNode,
  getNode,
  hashNodeToken,
  listNodes,
  listShopBeacons,
  mintNodeChannel,
  mintNodeToken,
  syncNodeConfig,
  type ShopNode,
} from "../../resources/nodes.js";
import { assertResourceShop, canConfigureResource } from "./merchant-resources.js";

export const merchantNodeRouter = new Hono<AppBindings>();
type C = Context<AppBindings>;

export function nodeWsUrl(c: C): string {
  const origin = c.env.APP_ORIGIN || new URL(c.req.url).origin;
  const httpUrl = `${origin.replace(/\/+$/, "")}${nodeRelayPath}`;
  return httpUrl.replace(/^http(s?):\/\//i, "ws$1://");
}

async function presentNodes(c: C, shopId: string, nodes: readonly ShopNode[]) {
  const [bindings, live] = await Promise.all([
    bindingsByNode(c.env.DB, shopId),
    (async () => {
      const map = new Map<string, { online: boolean; version: string | null; model: string | null; program: string | null; e2ee: boolean }>();
      const relay = machineRelayNamespace(c.env);
      if (!relay) return map;
      await Promise.all(
        nodes.map(async (node) => {
          try {
            const st = await relay.getByName(node.channel).nodeStatus();
            map.set(node.id, { online: st.online, version: st.version, model: st.model, program: st.program, e2ee: st.e2ee });
          } catch {
            // Unreachable DO leaves live status null rather than breaking the listing.
          }
        }),
      );
      return map;
    })(),
  ]);
  const wsUrl = nodeWsUrl(c);
  return nodes.map((node) => {
    const status = live.get(node.id) ?? null;
    return {
      id: node.id,
      shopId: node.shopId,
      kind: node.kind,
      name: node.name,
      enabled: node.enabled,
      channel: node.channel,
      hasToken: node.hasToken,
      wsUrl,
      config: node.config,
      online: status ? status.online : null,
      version: status?.version ?? null,
      model: status?.model ?? null,
      program: status?.program ?? null,
      e2ee: status?.e2ee ?? false,
      bindings: bindings.get(node.id) ?? [],
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  });
}

merchantNodeRouter.get("/nodes", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  const rawKind = c.req.query("kind");
  let kind: NodeKind | undefined;
  if (rawKind) {
    const parsed = nodeKindSchema.safeParse(rawKind);
    if (!parsed.success) jsonError(400, "无效的节点类型", "INVALID_NODE_KIND");
    kind = parsed.data;
  }
  const nodes = await listNodes(c.env.DB, shopId, kind);
  return c.json({ nodes: await presentNodes(c, shopId, nodes) });
});

const createNodeSchema = z.object({
  shopId: z.string().min(1),
  kind: nodeKindSchema,
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

merchantNodeRouter.post("/nodes", async (c) => {
  const user = requireUser(c);
  const parsed = createNodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) jsonError(422, "节点参数无效", "INVALID_NODE");
  const { shopId, kind, name } = parsed.data;
  if (!(await canConfigureResource(c, user, shopId))) jsonError(403, "需要设备管理权限", "FORBIDDEN");

  const cfgParsed = safeParseNodeConfig(kind, parsed.data.config ?? {});
  if (!cfgParsed.success) jsonError(422, "节点配置无效", "INVALID_NODE_CONFIG");
  let config: ReturnType<typeof parseNodeConfig> = cfgParsed.data;
  if (kind === "iot") {
    const iot = config as IotNodeConfig;
    if (iot.ble.enabled && iot.ble.beaconId === null) {
      config = { ...iot, ble: { ...iot.ble, beaconId: await allocateBeaconId(c.env.DB, shopId) } };
    }
  }

  const id = crypto.randomUUID();
  const channel = mintNodeChannel(kind);
  const token = mintNodeToken(kind);
  const credentialHash = await hashNodeToken(token);
  const now = new Date().toISOString();
  const enabled = parsed.data.enabled ?? true;

  await c.env.DB.prepare(
    `INSERT INTO shop_nodes (shop_id, id, kind, name, enabled, channel, credential_hash, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(shopId, id, kind, name, enabled ? 1 : 0, channel, credentialHash, JSON.stringify(config), now, now)
    .run();

  const created = (await getNode(c.env.DB, shopId, id))!;
  const [presented] = await presentNodes(c, shopId, [created]);
  return c.json({ node: presented, token, wsUrl: nodeWsUrl(c) }, 201);
});

const patchNodeSchema = z.object({
  shopId: z.string().min(1),
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  rotateToken: z.boolean().optional(),
});

merchantNodeRouter.patch("/nodes/:id", async (c) => {
  const user = requireUser(c);
  const parsed = patchNodeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) jsonError(422, "节点更新参数无效", "INVALID_NODE");
  const { shopId } = parsed.data;
  const nodeId = c.req.param("id")!;
  if (!(await canConfigureResource(c, user, shopId))) jsonError(403, "需要设备管理权限", "FORBIDDEN");

  const existing = await getNode(c.env.DB, shopId, nodeId);
  if (!existing) jsonError(404, "没有找到这个节点", "NODE_NOT_FOUND");

  let nextConfig = existing.config;
  if (parsed.data.config !== undefined) {
    const merged = { ...(existing.config as Record<string, unknown>), ...parsed.data.config };
    if (existing.kind === "iot" && typeof parsed.data.config.ble === "object" && parsed.data.config.ble !== null) {
      merged.ble = { ...(existing.config as IotNodeConfig).ble, ...(parsed.data.config.ble as Record<string, unknown>) };
    }
    const cfgParsed = safeParseNodeConfig(existing.kind, merged);
    if (!cfgParsed.success) jsonError(422, "节点配置无效", "INVALID_NODE_CONFIG");
    nextConfig = cfgParsed.data;
    if (existing.kind === "iot") {
      const iot = nextConfig as IotNodeConfig;
      if (iot.ble.enabled && iot.ble.beaconId === null) {
        nextConfig = { ...iot, ble: { ...iot.ble, beaconId: await allocateBeaconId(c.env.DB, shopId, nodeId) } };
      } else if (iot.ble.beaconId !== null) {
        const siblings = await listNodes(c.env.DB, shopId, "iot");
        const clash = siblings.find(
          (other) => other.id !== nodeId && (other.config as IotNodeConfig).ble.beaconId === iot.ble.beaconId,
        );
        if (clash) jsonError(409, `BLE 信标编号 ${iot.ble.beaconId} 已被「${clash.name}」使用`, "BEACON_ID_CONFLICT");
      }
    }
  }

  let rotatedToken: string | null = null;
  let nextHash: string | null = null;
  if (parsed.data.rotateToken) {
    rotatedToken = mintNodeToken(existing.kind);
    nextHash = await hashNodeToken(rotatedToken);
  }

  const nextName = parsed.data.name ?? existing.name;
  const nextEnabled = parsed.data.enabled ?? existing.enabled;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE shop_nodes
     SET name = ?, enabled = ?, config_json = ?,
         credential_hash = COALESCE(?, credential_hash),
         updated_at = ?
     WHERE shop_id = ? AND id = ?`,
  )
    .bind(nextName, nextEnabled ? 1 : 0, JSON.stringify(parseNodeConfig(existing.kind, nextConfig)), nextHash, now, shopId, nodeId)
    .run();

  await syncNodeConfig(c.env.DB, c.env, shopId, nodeId);
  if (existing.kind === "iot") {
    await refreshShopHub(c.env, shopId);
  }

  const updated = (await getNode(c.env.DB, shopId, nodeId))!;
  const [presented] = await presentNodes(c, shopId, [updated]);
  return c.json({ node: presented, ...(rotatedToken ? { token: rotatedToken, wsUrl: nodeWsUrl(c) } : {}) });
});

merchantNodeRouter.delete("/nodes/:id", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  if (!(await canConfigureResource(c, user, shopId))) jsonError(403, "需要设备管理权限", "FORBIDDEN");
  const nodeId = c.req.param("id")!;
  const existing = await getNode(c.env.DB, shopId, nodeId);
  if (!existing) jsonError(404, "没有找到这个节点", "NODE_NOT_FOUND");
  const bindings = (await bindingsByNode(c.env.DB, shopId)).get(nodeId) ?? [];
  if (bindings.length) {
    jsonError(409, `该节点仍被「${bindings[0]!.deviceName}」等资源绑定，请先解除绑定`, "NODE_IN_USE");
  }
  await c.env.DB.prepare("DELETE FROM shop_nodes WHERE shop_id = ? AND id = ?").bind(shopId, nodeId).run();
  return c.json({ ok: true });
});

/** Shop BLE beacon directory for proximity lookup & admin overview. */
merchantNodeRouter.get("/beacons", async (c) => {
  const user = requireUser(c);
  const shopId = c.req.query("shopId");
  if (!shopId) jsonError(400, "请选择店铺", "SHOP_REQUIRED");
  await assertResourceShop(c, user, shopId);
  return c.json({ beacons: await listShopBeacons(c.env.DB, shopId) });
});
