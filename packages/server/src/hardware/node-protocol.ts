/**
 * Unified edge-node protocol definitions and wire-format adapters.
 *
 * Every edge node (`hinata_io`, `launcher`, `iot`) follows the same server-
 * driven lifecycle: the node only stores how to connect (`url` + `token`),
 * announces passive runtime metadata on connect (`hello`), sends periodic
 * heartbeats, receives pushed runtime configuration, and answers RPC commands.
 *
 * Only the wire framing differs by `NodeKind`:
 * - `hinata_io`: keeps its existing action/JSON-RPC hybrid protocol so deployed
 *   IO builds keep working unchanged.
 * - `launcher` & `iot`: speak uniform JSON-RPC 2.0 (`node.hello`,
 *   `node.heartbeat`, `node.setConfig`, `ha.watch`, `ha.unwatch`, and typed
 *   command methods).
 */
import { z } from "zod";
import {
  isRecord,
  parseCabinetEvent,
  parseClientHello,
  parseHaStates,
  parseHeartbeat,
  parseIoEvent,
  parseReadersEvent,
  type CabinetSnapshot,
  type ClientHello,
  type HaReport,
  type IoEvent,
  type IoHeartbeat,
  type IoReader,
} from "./aimeio-relay.js";

export type HaHealth = IoHeartbeat["ha"][number];

export const nodeKinds = ["hinata_io", "launcher", "iot"] as const;
export type NodeKind = (typeof nodeKinds)[number];

export const nodeKindSchema = z.enum(nodeKinds);

// ---------------------------------------------------------------------------
// Node-own stored configuration (`shop_nodes.config_json`)
// ---------------------------------------------------------------------------

export const hinataNodeConfigSchema = z.object({
  haWatch: z.boolean().default(true),
});
export type HinataNodeConfig = z.infer<typeof hinataNodeConfigSchema>;

export const launcherNodeConfigSchema = z.object({
  haWatch: z.boolean().default(false),
});
export type LauncherNodeConfig = z.infer<typeof launcherNodeConfigSchema>;

export const iotBleConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Shop-unique beacon id (1..65535), auto-allocated by the server when enabled. */
  beaconId: z.number().int().min(1).max(65535).nullable().default(null),
  /** Calibrated RSSI at 1 m (dBm) advertised in the BLE packet. */
  txPower: z.number().int().min(-100).max(20).default(-59),
});
export type IotBleConfig = z.infer<typeof iotBleConfigSchema>;

export const iotNodeConfigSchema = z.object({
  haWatch: z.boolean().default(true),
  ble: iotBleConfigSchema.default({ enabled: true, beaconId: null, txPower: -59 }),
});
export type IotNodeConfig = z.infer<typeof iotNodeConfigSchema>;

export type NodeConfigByKind = {
  hinata_io: HinataNodeConfig;
  launcher: LauncherNodeConfig;
  iot: IotNodeConfig;
};

export type NodeConfig = NodeConfigByKind[NodeKind];

export function parseNodeConfig<K extends NodeKind>(kind: K, raw: unknown): NodeConfigByKind[K] {
  const input = isRecord(raw) ? raw : {};
  switch (kind) {
    case "hinata_io":
      return hinataNodeConfigSchema.parse(input) as NodeConfigByKind[K];
    case "launcher":
      return launcherNodeConfigSchema.parse(input) as NodeConfigByKind[K];
    case "iot":
      return iotNodeConfigSchema.parse(input) as NodeConfigByKind[K];
  }
}

export function safeParseNodeConfig(kind: NodeKind, raw: unknown) {
  const input = isRecord(raw) ? raw : {};
  switch (kind) {
    case "hinata_io":
      return hinataNodeConfigSchema.safeParse(input);
    case "launcher":
      return launcherNodeConfigSchema.safeParse(input);
    case "iot":
      return iotNodeConfigSchema.safeParse(input);
  }
}

// ---------------------------------------------------------------------------
// Server-pushed runtime configuration (`node.setConfig`)
// ---------------------------------------------------------------------------

export const programNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const launcherRootSchema = z.string().trim().min(1).max(512);

export const launcherProgramSchema = z.object({
  name: programNameSchema,
  path: z.string().min(1).max(512),
});
export type LauncherProgram = z.infer<typeof launcherProgramSchema>;

export type LauncherRuntimeConfig = {
  default: string | null;
  programs: LauncherProgram[];
  allowedRoots?: string[];
};

export type IotOutputPinConfig = {
  pin: number;
  activeLow: boolean;
  defaultPulseMs: number;
};

export type IotInputPinConfig = {
  pin: number;
  pull: "up" | "down" | "none";
  edge: "falling" | "rising" | "both";
  debounceMs: number;
};

export type IotRuntimeConfig = {
  ble: {
    enabled: boolean;
    beaconId: number | null;
    txPower: number;
  };
  gpio: {
    outputs: IotOutputPinConfig[];
    inputs: IotInputPinConfig[];
  };
};

export type NodeRuntimeConfig = LauncherRuntimeConfig | IotRuntimeConfig;

// ---------------------------------------------------------------------------
// Commands & RPC replies
// ---------------------------------------------------------------------------

export const MAX_HOST_FILE_BYTES = 512 * 1024;
export const MAX_HOST_PS_TIMEOUT_MS = 120_000;
export const DEFAULT_HOST_PS_TIMEOUT_MS = 15_000;

export const hostCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("switch"), name: programNameSchema }),
  z.object({ action: z.literal("key"), key: z.number().int().min(1).max(65535), count: z.number().int().min(1).max(20).default(1) }),
  z.object({ action: z.literal("text"), text: z.string().min(1).max(2048) }),
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("reboot") }),
  z.object({ action: z.literal("shutdown") }),
  z.object({ action: z.literal("fs.list"), path: z.string().min(1).max(1024) }),
  z.object({
    action: z.literal("fs.read"),
    path: z.string().min(1).max(1024),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
  z.object({
    action: z.literal("fs.write"),
    path: z.string().min(1).max(1024),
    content: z.string().max(750_000),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    createDirs: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("fs.mkdir"),
    path: z.string().min(1).max(1024),
    recursive: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("fs.rename"),
    from: z.string().min(1).max(1024),
    to: z.string().min(1).max(1024),
    overwrite: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("fs.delete"),
    path: z.string().min(1).max(1024),
    recursive: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("powershell"),
    script: z.string().min(1).max(32_768),
    cwd: z.string().min(1).max(1024).optional(),
    timeoutMs: z.number().int().min(1_000).max(MAX_HOST_PS_TIMEOUT_MS).default(DEFAULT_HOST_PS_TIMEOUT_MS),
    shell: z.enum(["powershell", "pwsh"]).default("powershell"),
  }),
]);
export type HostCommand = z.infer<typeof hostCommandSchema>;

export type NodeCallReply = { ok: boolean; result?: unknown; error?: string };

export type HaWatchPayload = {
  term: number;
  connections: Array<{ id: string; urls: string[]; token: string; entities: string[] }>;
};

// ---------------------------------------------------------------------------
// Wire-format encoders (Server -> Node)
// ---------------------------------------------------------------------------

export function encodeNodeConfig(kind: NodeKind, config: NodeRuntimeConfig): string | null {
  if (kind === "hinata_io") return null;
  return JSON.stringify({ jsonrpc: "2.0", method: "node.setConfig", params: config });
}

export function encodeNodeCommand(
  kind: NodeKind,
  input: { id: string; method: string; params: Record<string, unknown>; expiresAt: number },
): string {
  if (kind === "hinata_io" && input.method === "key.press") {
    return JSON.stringify({
      action: "KEY_PRESS",
      body: {
        key: input.params.key,
        count: input.params.count ?? 1,
        message_id: input.id,
        expires_at: input.expiresAt,
      },
    });
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: input.id,
    method: input.method,
    params: { ...input.params, expires_at: input.expiresAt },
  });
}

export function encodeNodeHaWatch(kind: NodeKind, watch: HaWatchPayload | null): string {
  if (kind === "hinata_io") {
    return JSON.stringify(watch ? { action: "HA_WATCH", body: watch } : { action: "HA_UNWATCH", body: {} });
  }
  return JSON.stringify(
    watch
      ? { jsonrpc: "2.0", method: "ha.watch", params: watch }
      : { jsonrpc: "2.0", method: "ha.unwatch", params: {} },
  );
}

// ---------------------------------------------------------------------------
// Wire-format decoder (Node -> Server)
// ---------------------------------------------------------------------------

export type GpioEventMessage = {
  pin: number;
  edge: "pulse" | "falling" | "rising" | "high" | "low";
  count: number;
  value?: number;
};

export type NodeHelloMessage = {
  version: string | null;
  model: string | null;
};

export type NodeHeartbeatMessage = {
  program?: string | null;
  uptimeSec?: number | null;
  ha?: HaHealth[];
};

export type NodeInbound =
  | { kind: "rpc_reply"; id: string; result?: unknown; error?: { code?: number; message: string } }
  | { kind: "io_hello"; hello: ClientHello }
  | { kind: "node_hello"; hello: NodeHelloMessage }
  | { kind: "io_heartbeat"; ha: HaHealth[]; cabinet: CabinetSnapshot | null; readers: IoReader[] | null }
  | { kind: "node_heartbeat"; heartbeat: NodeHeartbeatMessage }
  | { kind: "cabinet"; snapshot: CabinetSnapshot }
  | { kind: "readers"; readers: IoReader[]; change: { signal: string; reader: IoReader } | null }
  | { kind: "ha_report"; report: HaReport }
  | { kind: "gpio_event"; event: GpioEventMessage }
  | { kind: "io_event"; event: IoEvent };

function parseHaHealthList(raw: unknown): HaHealth[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ha: HaHealth[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.term !== "number" || typeof item.connection !== "string" || typeof item.connected !== "boolean") {
      continue;
    }
    ha.push({
      term: item.term,
      connection: item.connection,
      connected: item.connected,
      error: typeof item.error === "string" ? item.error : null,
    });
  }
  return ha;
}

export function parseNodeMessage(kind: NodeKind, raw: string): NodeInbound | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // JSON-RPC reply (shared across hinata_io, launcher, iot)
  if (typeof parsed.id === "string" && !("method" in parsed) && !("action" in parsed)) {
    const err = isRecord(parsed.error)
      ? {
          ...(typeof parsed.error.code === "number" ? { code: parsed.error.code } : {}),
          message: typeof parsed.error.message === "string" ? parsed.error.message : "节点返回错误",
        }
      : undefined;
    return { kind: "rpc_reply", id: parsed.id, ...(err ? { error: err } : { result: parsed.result }) };
  }

  if (kind === "hinata_io") {
    const hello = parseClientHello(parsed);
    if (hello) return { kind: "io_hello", hello };
    const heartbeat = parseHeartbeat(parsed);
    if (heartbeat) return { kind: "io_heartbeat", ...heartbeat };
    const books = parseCabinetEvent(parsed);
    if (books) return { kind: "cabinet", snapshot: books };
    const readers = parseReadersEvent(parsed);
    if (readers) return { kind: "readers", ...readers };
    const report = parseHaStates(parsed);
    if (report) return { kind: "ha_report", report };
    const event = parseIoEvent(raw);
    if (event) return { kind: "io_event", event };
    return null;
  }

  // Unified JSON-RPC 2.0 notifications for `launcher` and `iot`
  if (parsed.method === "node.hello") {
    const params = isRecord(parsed.params) ? parsed.params : {};
    return {
      kind: "node_hello",
      hello: {
        version: typeof params.version === "string" && params.version.trim() ? params.version.trim().slice(0, 64) : null,
        model: typeof params.model === "string" && params.model.trim() ? params.model.trim().slice(0, 64) : null,
      },
    };
  }

  if (parsed.method === "node.heartbeat") {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const ha = parseHaHealthList(params.ha);
    return {
      kind: "node_heartbeat",
      heartbeat: {
        ...("program" in params ? { program: typeof params.program === "string" ? params.program.slice(0, 64) : null } : {}),
        ...(typeof params.uptime_s === "number" && Number.isFinite(params.uptime_s) ? { uptimeSec: params.uptime_s } : {}),
        ...(ha !== undefined ? { ha } : {}),
      },
    };
  }

  // HA state reports from IoT / other JSON-RPC nodes share the same parser as IO (`ha.states` / `ha.status`)
  const report = parseHaStates(parsed);
  if (report) return { kind: "ha_report", report };

  if (kind === "iot" && parsed.method === "event.gpio") {
    const params = isRecord(parsed.params) ? parsed.params : {};
    const pin = params.pin;
    if (typeof pin !== "number" || !Number.isInteger(pin) || pin < 0 || pin > 255) return null;
    const rawEdge = typeof params.edge === "string" ? params.edge : "pulse";
    const edge =
      rawEdge === "pulse" || rawEdge === "falling" || rawEdge === "rising" || rawEdge === "high" || rawEdge === "low"
        ? rawEdge
        : "pulse";
    const count =
      typeof params.count === "number" && Number.isInteger(params.count) && params.count >= 1 && params.count <= 100
        ? params.count
        : 1;
    const value = typeof params.value === "number" ? params.value : undefined;
    return { kind: "gpio_event", event: { pin, edge, count, ...(value !== undefined ? { value } : {}) } };
  }

  return null;
}
