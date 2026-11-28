import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { deviceEventSchema } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import type { Env } from "../src/bindings.js";
import { MachineRelay } from "../src/durable-objects/machine-relay.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";
import {
  encodeNodeCommand,
  encodeNodeConfig,
  encodeNodeHaWatch,
  parseNodeMessage,
} from "../src/hardware/node-protocol.js";
import {
  allocateBeaconId,
  deriveNodeRuntimeConfig,
  getNode,
  listShopBeacons,
  resolveGpioInputTargets,
  validateNodePinConflicts,
} from "../src/resources/nodes.js";
import { createRuntimeBus } from "../src/resources/capabilities/runtime.js";
import { hasResourceLink, validateCapabilitySet } from "../src/resources/capabilities/catalog.js";
import { checkResourceLocation } from "../src/middleware/geo.js";
import { writeShopLocationSettingsStatement } from "../src/resources/location.js";
import type { TenantShop } from "../src/bindings.js";
import { can, loadResource } from "../src/resources/resource.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly attachment = { ref: null as unknown };
  closed: { code?: number; reason?: string } | null = null;

  send(payload: string) {
    this.sent.push(payload);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = { code, reason };
  }
  serializeAttachment(value: unknown) {
    this.attachment.ref = value;
  }
  deserializeAttachment() {
    return this.attachment.ref;
  }
}

beforeEach(() => {
  (globalThis as any).WebSocketPair = class {
    readonly 0: FakeSocket;
    readonly 1: FakeSocket;
    constructor() {
      this[0] = new FakeSocket();
      this[1] = new FakeSocket();
    }
  };
});

afterEach(() => {
  delete (globalThis as any).WebSocketPair;
});

function createDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE machines(
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL DEFAULT 'pub',
    shop_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Machine',
    aliases_json TEXT DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL DEFAULT 'machine',
    capacity INTEGER DEFAULT 1,
    occupancy_minutes INTEGER DEFAULT 15,
    created_at TEXT NOT NULL DEFAULT '2026-01-01'
  )`);
  sqlite.run(`CREATE TABLE players(shop_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(shop_id, id))`);
  sqlite.run(`CREATE TABLE app_settings(shop_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(shop_id, key))`);
  sqlite.run(`CREATE TABLE operation_locks(shop_id TEXT NOT NULL, scope TEXT NOT NULL, resource_id TEXT NOT NULL, lock_id TEXT NOT NULL, expires_at TEXT NOT NULL, acquired_at TEXT NOT NULL, PRIMARY KEY(shop_id, scope, resource_id))`);
  for (const stmt of deviceEventSchema) sqlite.run(stmt);
  return { sqlite, db: createD1DatabaseFromSqlite(sqlite) };
}

function createRelay(db: ReturnType<typeof createD1DatabaseFromSqlite>, extraEnv: Record<string, unknown> = {}) {
  const state = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  let alarm: number | null = null;
  const ctx = {
    storage: {
      async get<T>(key: string) { return state.get(key) as T | undefined; },
      async put(key: string, value: unknown) { state.set(key, value); },
      async delete(key: string) { return state.delete(key); },
      async getAlarm() { return alarm; },
      async setAlarm(at: number) { alarm = at; },
      async deleteAlarm() { alarm = null; },
    },
    acceptWebSocket(ws: FakeSocket) { sockets.push(ws); },
    getWebSockets() { return sockets; },
  };
  const env = { DB: db, ...extraEnv } as unknown as Env;
  const relay = new MachineRelay(ctx as any, env as any);
  return { relay, sockets, state, env };
}

describe("node protocol adapters", () => {
  it("encodes commands and HA watches according to node kind", () => {
    const expiresAt = 1_800_000_030_000;
    expect(JSON.parse(encodeNodeCommand("hinata_io", { id: "k1", method: "key.press", params: { key: 32, count: 2 }, expiresAt }))).toEqual({
      action: "KEY_PRESS",
      body: { key: 32, count: 2, message_id: "k1", expires_at: expiresAt },
    });
    expect(JSON.parse(encodeNodeCommand("iot", { id: "g1", method: "gpio.pulse", params: { pin: 12, duration_ms: 80, count: 1 }, expiresAt }))).toEqual({
      jsonrpc: "2.0",
      id: "g1",
      method: "gpio.pulse",
      params: { pin: 12, duration_ms: 80, count: 1, expires_at: expiresAt },
    });
    expect(JSON.parse(encodeNodeHaWatch("hinata_io", null))).toEqual({ action: "HA_UNWATCH", body: {} });
    expect(JSON.parse(encodeNodeHaWatch("iot", null))).toEqual({ jsonrpc: "2.0", method: "ha.unwatch", params: {} });
    expect(encodeNodeConfig("hinata_io", { default: null, programs: [] })).toBeNull();
    expect(JSON.parse(encodeNodeConfig("launcher", { default: "game", programs: [{ name: "game", path: "D:\\game.exe" }] })!)).toEqual({
      jsonrpc: "2.0",
      method: "node.setConfig",
      params: { default: "game", programs: [{ name: "game", path: "D:\\game.exe" }] },
    });
  });

  it("parses unified node.hello, node.heartbeat, rpc_reply, and event.gpio frames", () => {
    expect(parseNodeMessage("launcher", JSON.stringify({ jsonrpc: "2.0", method: "node.hello", params: { version: "0.2.0", model: "Win11" } }))).toEqual({
      kind: "node_hello",
      hello: { version: "0.2.0", model: "Win11" },
    });
    expect(parseNodeMessage("launcher", JSON.stringify({ jsonrpc: "2.0", method: "node.heartbeat", params: { program: "maimai" } }))).toEqual({
      kind: "node_heartbeat",
      heartbeat: { program: "maimai" },
    });
    expect(parseNodeMessage("iot", JSON.stringify({ jsonrpc: "2.0", method: "event.gpio", params: { pin: 13, edge: "falling", count: 2 } }))).toEqual({
      kind: "gpio_event",
      event: { pin: 13, edge: "falling", count: 2 },
    });
    expect(parseNodeMessage("iot", JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { pulsed: true } }))).toEqual({
      kind: "rpc_reply",
      id: "req-1",
      result: { pulsed: true },
    });
  });
});

describe("IoT & Launcher server-driven node architecture", () => {
  it("derives IoT node runtime config from multiple arcade machines and detects pin conflicts", async () => {
    const { sqlite, db } = createDb();
    sqlite.run(
      `INSERT INTO shop_nodes(shop_id,id,kind,name,enabled,channel,credential_hash,config_json,created_at,updated_at)
       VALUES ('shop-1','iot-1','iot','街机区控制器',1,'iot_chan1','hash1',?,'2026-01-01','2026-01-01')`,
      [JSON.stringify({ haWatch: true, ble: { enabled: true, beaconId: 7, txPower: -60 } })],
    );
    sqlite.run("INSERT INTO machines(id,shop_id,name,enabled) VALUES ('iot-res','shop-1','街机区控制器',1),('arc-1','shop-1','拳皇97',1),('arc-2','shop-1','街霸6',1)");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
       VALUES
         ('shop-1','iot-res','iot',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','arc-1','keys',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','arc-1','coin',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','arc-2','keys',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','arc-2','coin',?,'{}',NULL,'2026-01-01','2026-01-01')`,
      [
        JSON.stringify({ nodeId: "iot-1", haWatch: true, ble: { enabled: true, beaconId: 7, txPower: -60, rssiThreshold: -68 } }),
        JSON.stringify({ buttons: [{ id: "coin", name: "投币", mode: "gpio", nodeId: "iot-1", pin: 12, pulseMs: 80, activeLow: true }] }),
        JSON.stringify({ keyId: "coin", feedbackNodeId: "iot-1", feedbackPin: 13, feedbackEdge: "falling", feedbackDebounceMs: 40, feedbackSignal: "cabinet.coin" }),
        JSON.stringify({ buttons: [{ id: "coin", name: "投币", mode: "gpio", nodeId: "iot-1", pin: 14, pulseMs: 100, activeLow: false }] }),
        JSON.stringify({ keyId: "coin", feedbackNodeId: "iot-1", feedbackPin: 15, feedbackEdge: "rising", feedbackDebounceMs: 60, feedbackSignal: "cabinet.activity" }),
      ],
    );

    const node = (await getNode(db, "shop-1", "iot-1"))!;
    const runtimeConfig = await deriveNodeRuntimeConfig(db, "shop-1", node);
    expect(runtimeConfig).toEqual({
      ble: { enabled: true, beaconId: 7, txPower: -60 },
      gpio: {
        outputs: [
          { pin: 12, activeLow: true, defaultPulseMs: 80 },
          { pin: 14, activeLow: false, defaultPulseMs: 100 },
        ],
        inputs: [
          { pin: 13, pull: "up", edge: "falling", debounceMs: 40 },
          { pin: 15, pull: "down", edge: "rising", debounceMs: 60 },
        ],
      },
    });

    expect(await validateNodePinConflicts(db, "shop-1", "arc-3", "iot-1", [12])).toContain("拳皇97");
    expect(await validateNodePinConflicts(db, "shop-1", "arc-1", "iot-1", [12, 13])).toBeNull();
    expect(await validateNodePinConflicts(db, "shop-1", "arc-3", "iot-1", [16, 16])).toContain("重复");
    expect(await allocateBeaconId(db, "shop-1")).toBe(1);
    expect(await resolveGpioInputTargets(db, "shop-1", "iot-1", 13)).toEqual([
      { deviceId: "arc-1", capability: "coin", signal: "cabinet.coin" },
    ]);
    expect(await resolveGpioInputTargets(db, "shop-1", "iot-1", 15)).toEqual([
      { deviceId: "arc-2", capability: "coin", signal: "cabinet.activity" },
    ]);
    expect(await listShopBeacons(db, "shop-1")).toEqual([
      {
        nodeId: "iot-1",
        nodeName: "街机区控制器",
        resourceId: "iot-res",
        beaconId: 7,
        txPower: -60,
        rssiThreshold: -68,
        online: false,
      },
    ]);
  });

  it("pushes node.setConfig on IoT connect, registers HA watcher, pulses GPIO coin via DeviceBus, and records GPIO feedback signals", async () => {
    const { sqlite, db } = createDb();
    sqlite.run(
      `INSERT INTO shop_nodes(shop_id,id,kind,name,enabled,channel,credential_hash,config_json,created_at,updated_at)
       VALUES ('shop-1','iot-1','iot','街机控制器',1,'iot_chan1','hash1',?,'2026-01-01','2026-01-01')`,
      [JSON.stringify({ haWatch: true, ble: { enabled: true, beaconId: 3, txPower: -59 } })],
    );
    sqlite.run("INSERT INTO machines(id,shop_id,name,enabled) VALUES ('arc-1','shop-1','复古街机',1)");
    sqlite.run("INSERT INTO players(shop_id,id) VALUES ('shop-1','player-1')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
       VALUES ('shop-1','arc-1','coin',?,'{}',NULL,'2026-01-01','2026-01-01')`,
      [JSON.stringify({ method: "gpio", nodeId: "iot-1", pin: 12, pulseMs: 90, activeLow: true, feedbackPin: 13, feedbackSignal: "cabinet.coin" })],
    );

    const hubCalls: unknown[][] = [];
    const { relay, sockets, env } = createRelay(db, {
      SHOP_HUB: {
        getByName: () => ({
          async relayOnline(...args: unknown[]) { hubCalls.push(["online", ...args]); },
          async relayOffline(...args: unknown[]) { hubCalls.push(["offline", ...args]); },
          async haReport(...args: unknown[]) { hubCalls.push(["report", ...args]); },
        }),
      },
    });

    await relay.fetch(
      new Request("https://prism.test/node/ws", {
        headers: {
          Upgrade: "websocket",
          "x-prism-relay-shop": "shop-1",
          "x-prism-relay-node": "iot-1",
          "x-prism-relay-kind": "iot",
          "x-prism-relay-channel": "iot_chan1",
          "x-prism-relay-label": encodeURIComponent("街机控制器"),
        },
      }),
    );

    const ws = sockets[0]!;
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      jsonrpc: "2.0",
      method: "node.setConfig",
      params: {
        ble: { enabled: true, beaconId: 3, txPower: -59 },
        gpio: {
          outputs: [{ pin: 12, activeLow: true, defaultPulseMs: 90 }],
          inputs: [{ pin: 13, pull: "up", edge: "falling", debounceMs: 50 }],
        },
      },
    });
    expect(hubCalls[0]).toMatchObject(["online", "shop-1", "node:iot-1", "iot_chan1", { kind: "iot", label: "街机控制器" }]);

    // HA watch uses JSON-RPC format for IoT nodes.
    expect((await relay.watchHa({ term: 2, connections: [] })).ok).toBe(true);
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ jsonrpc: "2.0", method: "ha.watch", params: { term: 2, connections: [] } });

    // Trigger `coin` on the real arcade machine (which has NO hinata_io!) via DeviceBus.
    const device = (await loadResource(db, "shop-1", "arc-1"))!;
    expect(can(device, "coin")).toBe(true);
    const busEnv = { ...env, MACHINE_RELAY: { getByName: () => relay } } as unknown as Env;
    const bus = createRuntimeBus({ db, env: busEnv, shopId: "shop-1", via: { channel: "page", resourceId: null } });
    const coinPromise = bus.perform({
      device,
      action: "coin",
      actor: { type: "player", playerId: "player-1" },
      payload: { count: 2 },
    });
    await Bun.sleep(10);
    const pulseFrame = JSON.parse(ws.sent.at(-1)!);
    expect(pulseFrame).toMatchObject({
      jsonrpc: "2.0",
      method: "gpio.pulse",
      params: { pin: 12, duration_ms: 90, count: 2, active_low: true },
    });
    await relay.webSocketMessage(ws as any, JSON.stringify({ jsonrpc: "2.0", id: pulseFrame.id, result: { ok: true } }));
    const outcome = await coinPromise;
    expect(outcome.operation.status).toBe("succeeded");

    // Hardware node reports a coin feedback pulse on GPIO 13 -> recorded as standard `cabinet.coin` signal.
    await relay.webSocketMessage(ws as any, JSON.stringify({ jsonrpc: "2.0", method: "event.gpio", params: { pin: 13, edge: "falling", count: 1 } }));
    const signals = sqlite.query<{ device_id: string; capability: string; name: string }, []>(
      "SELECT device_id, capability, name FROM device_events WHERE kind = 'signal'",
    ).all();
    expect(signals).toContainEqual({ device_id: "arc-1", capability: "occupancy", name: "occupancy.started" });
    expect(signals).toContainEqual({ device_id: "arc-1", capability: "coin", name: "cabinet.coin" });
  });

  it("drives Launcher (`host` capability) through DeviceBus and supports explicit IO-to-Launcher coin fallback", async () => {
    const { sqlite, db } = createDb();
    sqlite.run(
      `INSERT INTO shop_nodes(shop_id,id,kind,name,enabled,channel,credential_hash,config_json,created_at,updated_at)
       VALUES
         ('shop-1','io-1','hinata_io','机台1 IO',1,'m_chan1','hash_io','{}','2026-01-01','2026-01-01'),
         ('shop-1','ln-1','launcher','机台1 Launcher',1,'ln_chan1','hash_ln','{}','2026-01-01','2026-01-01')`,
    );
    sqlite.run("INSERT INTO machines(id,shop_id,name,enabled) VALUES ('pc-1','shop-1','音游1号',1)");
    sqlite.run("INSERT INTO players(shop_id,id) VALUES ('shop-1','player-1')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
       VALUES
         ('shop-1','pc-1','hinata_io',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','pc-1','host',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','pc-1','coin',?,'{}',NULL,'2026-01-01','2026-01-01')`,
      [
        JSON.stringify({ transport: "embedded", nodeId: "io-1", channel: "m_chan1", keys: [{ id: "coin", name: "投币", key: 32 }] }),
        JSON.stringify({ nodeId: "ln-1", defaultProgram: "music", programs: [{ name: "music", path: "D:\\music.exe" }], keys: [] }),
        JSON.stringify({ method: "key", keyId: "coin", keyTarget: "hinata_io", fallbackToLauncher: true }),
      ],
    );

    const ioRelay = createRelay(db);
    const lnRelay = createRelay(db);

    await lnRelay.relay.fetch(
      new Request("https://prism.test/node/ws", {
        headers: {
          Upgrade: "websocket",
          "x-prism-relay-shop": "shop-1",
          "x-prism-relay-node": "ln-1",
          "x-prism-relay-kind": "launcher",
          "x-prism-relay-channel": "ln_chan1",
        },
      }),
    );
    const lnWs = lnRelay.sockets[0]!;
    expect(JSON.parse(lnWs.sent[0]!)).toEqual({
      jsonrpc: "2.0",
      method: "node.setConfig",
      params: { default: "music", programs: [{ name: "music", path: "D:\\music.exe" }] },
    });

    await lnRelay.relay.webSocketMessage(lnWs as any, JSON.stringify({ jsonrpc: "2.0", method: "node.heartbeat", params: { program: "music" } }));
    expect(await lnRelay.relay.nodeStatus()).toMatchObject({ online: true, kind: "launcher", program: "music" });

    const busEnv = {
      DB: db,
      MACHINE_RELAY: {
        getByName: (name: string) => (name === "m_chan1" ? ioRelay.relay : lnRelay.relay),
      },
    } as unknown as Env;
    const device = (await loadResource(db, "shop-1", "pc-1"))!;
    const bus = createRuntimeBus({ db, env: busEnv, shopId: "shop-1", via: { channel: "merchant", resourceId: null } });

    // Host switch audited through DeviceBus.
    const switchPromise = bus.perform({
      device,
      action: "host.switch",
      actor: { type: "staff", staffId: "staff-1" },
      payload: { name: "music" },
    });
    await Bun.sleep(10);
    const switchFrame = JSON.parse(lnWs.sent.at(-1)!);
    expect(switchFrame).toMatchObject({ jsonrpc: "2.0", method: "host.switch", params: { name: "music" } });
    await lnRelay.relay.webSocketMessage(lnWs as any, JSON.stringify({ jsonrpc: "2.0", id: switchFrame.id, result: {} }));
    expect((await switchPromise).operation.status).toBe("succeeded");

    // IO is offline, so `coin` explicitly falls back to the bound Launcher node.
    const coinPromise = bus.perform({
      device,
      action: "coin",
      actor: { type: "player", playerId: "player-1" },
      payload: { count: 1 },
    });
    await Bun.sleep(10);
    const keyFrame = JSON.parse(lnWs.sent.at(-1)!);
    expect(keyFrame).toMatchObject({ jsonrpc: "2.0", method: "key.press", params: { key: 32, count: 1 } });
    await lnRelay.relay.webSocketMessage(lnWs as any, JSON.stringify({ jsonrpc: "2.0", id: keyFrame.id, result: {} }));
    expect((await coinPromise).operation.status).toBe("succeeded");

    // Host fs.list and powershell through DeviceBus + MachineRelay.
    const fsPromise = bus.perform({
      device,
      action: "host.fs.list",
      actor: { type: "staff", staffId: "staff-1" },
      payload: { path: "D:\\Games" },
    });
    await Bun.sleep(10);
    const fsFrame = JSON.parse(lnWs.sent.at(-1)!);
    expect(fsFrame).toMatchObject({ jsonrpc: "2.0", method: "host.fs.list", params: { path: "D:\\Games" } });
    await lnRelay.relay.webSocketMessage(
      lnWs as any,
      JSON.stringify({ jsonrpc: "2.0", id: fsFrame.id, result: { path: "D:\\Games", entries: [], truncated: false } }),
    );
    const fsOutcome = await fsPromise;
    expect(fsOutcome.operation.status).toBe("succeeded");
    expect(fsOutcome.result).toEqual({ path: "D:\\Games", entries: [], truncated: false });

    const psPromise = bus.perform({
      device,
      action: "host.powershell",
      actor: { type: "staff", staffId: "staff-1" },
      payload: { timeoutMs: 45_000, shell: "powershell" },
      transient: { script: "Get-Process" },
    });
    await Bun.sleep(10);
    const psFrame = JSON.parse(lnWs.sent.at(-1)!);
    expect(psFrame).toMatchObject({
      jsonrpc: "2.0",
      method: "host.powershell",
      params: { script: "Get-Process", timeoutMs: 45_000, shell: "powershell" },
    });
    await lnRelay.relay.webSocketMessage(
      lnWs as any,
      JSON.stringify({
        jsonrpc: "2.0",
        id: psFrame.id,
        result: { stdout: "proc\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 30 },
      }),
    );
    const psOutcome = await psPromise;
    expect(psOutcome.operation.status).toBe("succeeded");
    expect(psOutcome.result).toMatchObject({ stdout: "proc\n", exitCode: 0, timedOut: false });
  });

  it("ranks dedicated IoT hardware ahead of bots and HINATA IOs in ShopHub HA watcher pool", async () => {
    const { db } = createDb();
    const state = new Map<string, unknown>();
    const told: Array<{ channel: string; watch: unknown }> = [];
    const ctx = {
      storage: {
        async get<T>(key: string) { return state.get(key) as T | undefined; },
        async put(key: string, value: unknown) { state.set(key, value); },
        async delete(key: string) { return state.delete(key); },
        async getAlarm() { return null; },
        async setAlarm() {},
        async deleteAlarm() {},
      },
      getWebSockets() { return []; },
    };
    const env = {
      DB: db,
      URL_ENCRYPTION_KEY: "test-key",
      MACHINE_RELAY: {
        getByName: (channel: string) => ({
          async watchHa(watch: unknown) {
            told.push({ channel, watch });
            return { ok: true };
          },
        }),
      },
    } as unknown as Env;

    const hub = new ShopHub(ctx as any, env as any);
    await hub.relayOnline("shop-1", "machine-1", "m_io1", { session: "s1", kind: "hinata_io" });
    await hub.relayOnline("shop-1", "node:iot-1", "iot_1", { session: "s2", kind: "iot", label: "墙面控制器" });
    const ranked = (hub as any).ranked(state.get("candidates"), {}, Date.now(), {});
    expect(ranked.map((c: { machineId: string }) => c.machineId)).toEqual(["node:iot-1", "machine-1"]);
  });

  it("enforces capability conflict, dependency, and link rules", () => {
    expect(validateCapabilitySet(["bot", "power"])?.code).toBe("CAPABILITY_CONFLICT");
    expect(validateCapabilitySet(["iot", "table"])?.code).toBe("CAPABILITY_CONFLICT");
    expect(validateCapabilitySet(["iot", "door"])?.code).toBe("CAPABILITY_CONFLICT");
    expect(validateCapabilitySet(["iot", "climate"])?.code).toBe("CAPABILITY_CONFLICT");
    expect(validateCapabilitySet(["table", "climate"])).toBeNull();
    expect(validateCapabilitySet(["iot", "keys", "coin"])).toBeNull();
    expect(validateCapabilitySet(["coin"])?.code).toBe("CAPABILITY_DEPENDENCY");

    expect(hasResourceLink([])).toBe(true);
    expect(hasResourceLink(["bot"])).toBe(false);
    expect(hasResourceLink(["iot"])).toBe(false);
    expect(hasResourceLink(["iot", "keys", "coin"])).toBe(true);
  });

  it("prefers PRiSM Launcher for keyboard buttons and falls back to HINATA IO when Launcher is offline", async () => {
    const { sqlite, db } = createDb();
    sqlite.run(
      `INSERT INTO shop_nodes(shop_id,id,kind,name,enabled,channel,credential_hash,config_json,created_at,updated_at)
       VALUES
         ('shop-1','io-1','hinata_io','机台1 IO',1,'m_chan1','hash_io','{}','2026-01-01','2026-01-01'),
         ('shop-1','ln-1','launcher','机台1 Launcher',1,'ln_chan1','hash_ln','{}','2026-01-01','2026-01-01')`,
    );
    sqlite.run("INSERT INTO machines(id,shop_id,name,enabled) VALUES ('pc-2','shop-1','音游2号',1)");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
       VALUES
         ('shop-1','pc-2','hinata_io',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','pc-2','host',?,'{}',NULL,'2026-01-01','2026-01-01'),
         ('shop-1','pc-2','keys',?,'{}',NULL,'2026-01-01','2026-01-01')`,
      [
        JSON.stringify({ transport: "embedded", nodeId: "io-1", channel: "m_chan1" }),
        JSON.stringify({ nodeId: "ln-1", defaultProgram: null, programs: [] }),
        JSON.stringify({ buttons: [{ id: "test", name: "测试", mode: "keyboard", key: 112 }] }),
      ],
    );

    const ioRelay = createRelay(db);
    const lnRelay = createRelay(db);

    // Connect ONLY HINATA IO (Launcher stays offline) -> keyboard press falls back to HINATA IO.
    await ioRelay.relay.fetch(
      new Request("https://prism.test/io/ws", {
        headers: {
          Upgrade: "websocket",
          "x-prism-relay-shop": "shop-1",
          "x-prism-relay-machine": "pc-2",
          "x-prism-relay-node": "io-1",
          "x-prism-relay-kind": "hinata_io",
          "x-prism-relay-channel": "m_chan1",
        },
      }),
    );
    const ioWs = ioRelay.sockets[0]!;
    const busEnv = {
      DB: db,
      MACHINE_RELAY: { getByName: (name: string) => (name === "m_chan1" ? ioRelay.relay : lnRelay.relay) },
    } as unknown as Env;
    const device = (await loadResource(db, "shop-1", "pc-2"))!;
    expect(can(device, "key.press")).toBe(true);
    const bus = createRuntimeBus({ db, env: busEnv, shopId: "shop-1", via: { channel: "merchant", resourceId: null } });

    const fallbackOutcome = await bus.perform({
      device,
      action: "key.press",
      actor: { type: "staff", staffId: "staff-1" },
      payload: { keyId: "test" },
    });
    expect(fallbackOutcome.operation.status).toBe("succeeded");
    expect(JSON.parse(ioWs.sent.at(-1)!)).toMatchObject({ action: "KEY_PRESS", body: { key: 112, count: 1 } });
  });

  it("strictly prefers online BLE beacons and automatically falls back to GPS when no beacon is online", async () => {
    const { sqlite, db } = createDb();
    sqlite.run(
      `INSERT INTO shop_nodes(shop_id,id,kind,name,enabled,channel,credential_hash,config_json,created_at,updated_at)
       VALUES ('shop-1','iot-1','iot','入口信标',1,'iot_c1','h1',?,'2026-01-01','2026-01-01')`,
      [JSON.stringify({ haWatch: true, ble: { enabled: true, beaconId: 42, txPower: -59 } })],
    );
    sqlite.run("INSERT INTO machines(id,shop_id,name,enabled) VALUES ('iot-dev','shop-1','入口信标',1),('m-pin','shop-1','限定信标机台',1),('m-none','shop-1','免定位机台',1),('m-plain','shop-1','普通机台',1)");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop-1','iot-dev','iot',?,'{}','2026-01-01','2026-01-01')`,
      [JSON.stringify({ nodeId: "iot-1", haWatch: true, ble: { enabled: true, beaconId: 42, txPower: -59, rssiThreshold: -75 } })],
    );
    sqlite.run(
      `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
       VALUES ('shop-1','iot-dev','iot','link','"online"','owned','2026-01-01')`,
    );
    await writeShopLocationSettingsStatement(db, "shop-1", {
      rssiThreshold: -75,
      resources: {
        "m-pin": { mode: "require", beaconNodeId: "iot-1", rssiThreshold: -70 },
        "m-none": { mode: "none", beaconNodeId: null, rssiThreshold: null },
      },
    }).run();

    const shop = {
      id: "shop-1",
      public_id: "shop1",
      name: "测试店",
      time_zone: "Asia/Shanghai",
      hero_url: null,
      latitude: 31.2304,
      longitude: 121.4737,
      radius_meters: 100,
      checkin_geo: 1,
      checkout_geo: 1,
      machine_geo: 1,
      auto_register: 1,
      identity_binding_required: 0,
      cashier_enabled: 0,
      bot_contact: "",
    } as unknown as TenantShop;

    // `none` override skips verification completely even without location payload.
    await checkResourceLocation({ db, shop, action: "machine", deviceId: "m-none", location: undefined });

    // With an online BLE beacon, pinned resource strictly enforces BLE (RSSI >= -70) and refuses GPS-only payload.
    await checkResourceLocation({
      db,
      shop,
      action: "machine",
      deviceId: "m-pin",
      location: { beacons: [{ beaconId: 42, rssi: -65 }] },
    });
    await expect(
      checkResourceLocation({
        db,
        shop,
        action: "machine",
        deviceId: "m-pin",
        location: { beacons: [{ beaconId: 42, rssi: -85 }] },
      }),
    ).rejects.toThrow();
    await expect(
      checkResourceLocation({
        db,
        shop,
        action: "machine",
        deviceId: "m-plain",
        location: { lat: 31.2304, lng: 121.4737, accuracy: 20 },
      }),
    ).rejects.toThrow();

    // Once all beacons go offline, verification automatically falls back to GPS geofence.
    sqlite.run("UPDATE device_state SET value_json='\"offline\"' WHERE shop_id='shop-1' AND device_id='iot-dev' AND capability='iot' AND key='link'");
    await checkResourceLocation({
      db,
      shop,
      action: "machine",
      deviceId: "m-plain",
      location: { lat: 31.2304, lng: 121.4737, accuracy: 20 },
    });
    await expect(
      checkResourceLocation({
        db,
        shop,
        action: "machine",
        deviceId: "m-plain",
        location: { beacons: [{ beaconId: 42, rssi: -55 }] },
      }),
    ).rejects.toThrow();
  });
});
