import type { Env } from "../bindings.js";
import { sha256Hex } from "../crypto.js";
import type { HaWatch } from "../durable-objects/machine-relay.js";
import type { AwaitSpec, Awaited } from "../resources/capabilities/bus.js";
import type { CabinetSnapshot } from "../hardware/aimeio-relay.js";
import type { NodeCallReply, NodeKind, NodeRuntimeConfig } from "../hardware/node-protocol.js";
import { isRelayPath } from "./relay-path.js";
import { findHinataMachineForNode } from "../resources/nodes.js";
import { logger } from "../log.js";

const log = logger("machine-relay");

export type RelayGatewayResult =
  | { kind: "not-relay" }
  | { kind: "rejected"; response: Response }
  | {
      kind: "dispatch";
      channel: string;
      shopId: string;
      nodeId: string;
      nodeKind: NodeKind;
      nodeName?: string;
      machineId?: string;
    };

type ShopNodeAuthRow = {
  shop_id: string;
  id: string;
  kind: string;
  name: string;
  channel: string;
};

type LegacyResourceRow = { device_id: string; shop_id: string; channel: string | null };

/**
 * Authenticate an edge node connecting to `/node/ws` or legacy `/io/ws`.
 *
 * The node presents its Bearer token on the WebSocket upgrade request, which is
 * the last point where a credential can be checked before the socket exists.
 * The shop, node id, node kind, and Durable Object channel are resolved *from*
 * the token so nothing identifying appears in the URL and clients cannot spoof
 * another node kind.
 */
export async function relayGateway(
  request: Request,
  env: Env,
): Promise<RelayGatewayResult> {
  const url = new URL(request.url);
  if (!isRelayPath(url.pathname)) return { kind: "not-relay" };

  if (!env.MACHINE_RELAY) {
    return { kind: "rejected", response: rejected("relay binding not configured") };
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return { kind: "rejected", response: new Response("Expected Upgrade: websocket", { status: 426 }) };
  }
  const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return { kind: "rejected", response: rejected("missing bearer token") };

  const tokenHash = await sha256Hex(token);

  // Primary path: unified `shop_nodes` table (hinata_io, launcher, iot).
  let node: ShopNodeAuthRow | null = null;
  try {
    node = await env.DB.prepare(
      `SELECT shop_id, id, kind, name, channel
       FROM shop_nodes
       WHERE credential_hash = ? AND enabled = 1`,
    )
      .bind(tokenHash)
      .first<ShopNodeAuthRow>();
  } catch {
    // Allow unmigrated test databases that only created `device_capabilities`.
  }

  if (node && (node.kind === "hinata_io" || node.kind === "launcher" || node.kind === "iot")) {
    let machineId: string | undefined;
    if (node.kind === "hinata_io") {
      const bound = await findHinataMachineForNode(env.DB, node.shop_id, node.id, node.channel).catch(() => null);
      if (bound && !bound.enabled) {
        return { kind: "rejected", response: rejected("bound machine is disabled") };
      }
      machineId = bound?.deviceId;
    }
    return {
      kind: "dispatch",
      channel: node.channel,
      shopId: node.shop_id,
      nodeId: node.id,
      nodeKind: node.kind,
      nodeName: node.name,
      ...(machineId ? { machineId } : {}),
    };
  }

  // Fallback path: legacy embedded `hinata_io` rows not yet migrated to `shop_nodes`.
  const device = await env.DB.prepare(
    `SELECT c.device_id, c.shop_id, json_extract(c.config_json, '$.channel') AS channel
     FROM device_capabilities c JOIN machines m ON m.id = c.device_id AND m.shop_id = c.shop_id
     WHERE c.credential_hash = ? AND c.capability = 'hinata_io'
       AND json_extract(c.config_json, '$.transport') = 'embedded' AND m.enabled = 1`,
  )
    .bind(tokenHash)
    .first<LegacyResourceRow>();
  if (!device) return { kind: "rejected", response: rejected("unknown or disabled device token") };
  if (!device.channel) {
    return { kind: "rejected", response: rejected("device has no relay channel") };
  }

  return {
    kind: "dispatch",
    channel: device.channel,
    shopId: device.shop_id,
    nodeId: `io_${device.device_id}`,
    nodeKind: "hinata_io",
    machineId: device.device_id,
  };
}

/**
 * 401, not 404. The client treats 401/403 as a permanent failure and stops
 * retrying with a clear log line; anything else looks like a transient outage
 * and it would retry a bad token forever.
 */
function rejected(reason: string): Response {
  log.warn(`refused a machine connection: ${reason}`, { event: "machine_relay_rejected", reason });
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  });
}

export type NodeLiveStatus = {
  online: boolean;
  kind: NodeKind;
  version: string | null;
  model: string | null;
  program: string | null;
  e2ee: boolean;
};

/**
 * A structural view of the relay namespace. The generated `DurableObjectNamespace`
 * generic is too deep for `tsc` to instantiate when chained, and the existing
 * LiveBilling call site narrows the same way.
 */
export type MachineRelayNamespace = {
  getByName(name: string): {
    nodeStatus(): Promise<NodeLiveStatus>;
    pushConfig(config: NodeRuntimeConfig): Promise<{ delivered: boolean }>;
    callNode(
      method: string,
      params: Record<string, unknown>,
      options?: { id?: string; expiresAt?: number; timeoutMs?: number },
    ): Promise<NodeCallReply>;
    sendCard(input: {
      accessCode: string;
      source?: string;
      disposable?: boolean;
      duration?: number;
      wait?: AwaitSpec;
    }): Promise<{ ok: boolean; error?: string; awaited?: Awaited }>;
    sendKeyPress(input: { key: number; messageId: string; expiresAt: number; count?: number }):
      Promise<{ ok: boolean; error?: string }>;
    watchHa(watch: HaWatch | null, session?: string): Promise<{ ok: boolean }>;
    readCabinet(): Promise<{ ok: true; cabinet: CabinetSnapshot } | { ok: false; error: string }>;
    startCardCapture(input: {
      id: string; shopId: string; userId: string; playerId: string; expiresAt: number;
    }): Promise<{ ok: boolean; error?: string }>;
    cardCaptureResult(id: string, userId: string): Promise<{ status: string; cardType?: string }>;
    cancelCardCapture(id: string, userId: string): Promise<void>;
    getCapabilities(): Promise<{
      online: boolean;
      e2ee: boolean;
      agents: Array<{ cardProtocol: number; clientVersion: string }>;
    }>;
  };
};

export function machineRelayNamespace(env: Env): MachineRelayNamespace | undefined {
  return env.MACHINE_RELAY as unknown as MachineRelayNamespace | undefined;
}

/** Forward an authenticated upgrade to the node's Durable Object. */
export async function dispatchToRelay(
  request: Request,
  env: Env,
  target: {
    channel: string;
    shopId: string;
    nodeId: string;
    nodeKind: NodeKind;
    nodeName?: string;
    machineId?: string;
  },
): Promise<Response> {
  const namespace = env.MACHINE_RELAY as unknown as {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  const headers = new Headers(request.headers);
  headers.set("x-prism-relay-shop", target.shopId);
  headers.set("x-prism-relay-channel", target.channel);
  headers.set("x-prism-relay-node", target.nodeId);
  headers.set("x-prism-relay-kind", target.nodeKind);
  if (target.nodeName) headers.set("x-prism-relay-label", encodeURIComponent(target.nodeName));
  if (target.machineId) headers.set("x-prism-relay-machine", target.machineId);
  // `webSocket` must be carried over untouched for the upgrade to complete; only
  // the headers differ from what arrived.
  const forwarded = new Request(request, { headers });
  return namespace.get(namespace.idFromName(target.channel)).fetch(forwarded);
}
