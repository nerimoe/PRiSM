import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { encryptSecret } from "../src/crypto.js";
import { loadResource } from "../src/resources/resource.js";
import { getHaConnection, newHaConnection, writeHaConnection } from "../src/resources/capabilities/ha-connections.js";
import { readLiveState } from "../src/resources/capabilities/device-state.js";
import { LEASE_MS, ShopHub } from "../src/durable-objects/shop-hub.js";
import { MachineRelay, type HaWatch } from "../src/durable-objects/machine-relay.js";

const KEY = "hub-test-key";
const SHOP = "shop-1";

async function fixture(options: { climate?: boolean; legacy?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.run(`CREATE TABLE players(shop_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(shop_id, id))`);
  sqlite.run(
    `CREATE TABLE machines(shop_id TEXT NOT NULL, id TEXT NOT NULL, public_id TEXT, name TEXT, aliases_json TEXT,
       kind TEXT DEFAULT 'machine', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT '2026-01-01', capacity INTEGER NOT NULL DEFAULT 0, occupancy_minutes INTEGER NOT NULL DEFAULT 15, PRIMARY KEY(shop_id, id))`,
  );
  sqlite.run(`CREATE TABLE app_settings(shop_id TEXT, key TEXT, value_json TEXT, updated_at TEXT, PRIMARY KEY(shop_id, key))`);
  for (const statement of deviceEventSchema) sqlite.run(statement);
  const db = createD1DatabaseFromSqlite(sqlite);
  const made = {
    ...(await newHaConnection("https://ha.example", "control", KEY)),
    internalUrl: "http://ha.local:8123",
  };
  const connection = {
    ...made,
    readToken: await encryptSecret("reader", KEY),
    readAccess: "ready" as const,
  };
  // A connection from before read-only accounts existed has neither.
  await writeHaConnection(db, SHOP, options.legacy ? made : connection).run();
  const bind = (device: string, capability: string, entity: string) => {
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES (?,?,?,?,'{}','2026-01-01','2026-01-01')`,
      [SHOP, device, capability, JSON.stringify({ connectionId: connection.id, entityId: entity })],
    );
  };
  for (const [device, entity] of [["m1", "switch.a"], ["m2", "switch.b"]] as const) {
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,aliases_json) VALUES (?,?,?,?,'[]')", [SHOP, device, `pub-${device}`, device]);
    bind(device, "power", entity);
  }
  if (options.climate) {
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,aliases_json) VALUES (?,?,?,?,'[]')", [SHOP, "m3", "pub-m3", "m3"]);
    bind("m3", "climate", "climate.c");
  }
  const watches: Array<{ channel: string; watch: HaWatch | null }> = [];
  const reachable = new Set(["chan-a", "chan-b", "chan-c"]);
  const env = {
    DB: db,
    URL_ENCRYPTION_KEY: KEY,
    APP_ORIGIN: "https://prism.test",
    MACHINE_RELAY: {
      getByName: (channel: string) => ({
        async watchHa(watch: HaWatch | null) {
          watches.push({ channel, watch });
          return { ok: reachable.has(channel) };
        },
      }),
    },
  };
  const state = new Map<string, unknown>();
  const sockets: any[] = [];
  const puts: string[] = [];
  let alarm: number | null = null;
  let alarms = 0;
  const alarmHistory: number[] = [];
  /** Work the hub left running after answering, such as asking Home Assistant for a new board. */
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); },
    storage: {
      async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { puts.push(key); state.set(key, structuredClone(value)); },
      async delete(key: string) { return state.delete(key); },
      async getAlarm() { return alarm; },
      async setAlarm(at: number) { alarms += 1; alarm = at; alarmHistory.push(at); },
      async deleteAlarm() { alarm = null; },
    },
    acceptWebSocket(ws: any, tags: string[] = []) { ws.tags = tags; sockets.push(ws); },
    getWebSockets(tag?: string) { return tag ? sockets.filter((ws) => ws.tags?.includes(tag)) : sockets; },
  };
  const hub = new ShopHub(ctx as any, env as any);
  const rows = <T>(sql: string) => sqlite.query<T, []>(sql).all();
  const power = () => rows<{ device_id: string; value_json: string; changed_at: string }>(
    "SELECT device_id, value_json, changed_at FROM device_state WHERE key='power' ORDER BY device_id",
  );
  const changes = (capability: string) => rows<{ name: string; payload_json: string }>(
    `SELECT name, payload_json FROM device_events WHERE kind='change' AND capability='${capability}' ORDER BY occurred_at, id`,
  );
  const watched = () => rows<{ connection_id: string }>("SELECT connection_id FROM ha_event_connections").map((row) => row.connection_id);
  const facts = async (deviceId: string) => readLiveState(db, SHOP, (await loadResource(db, SHOP, deviceId))!);
  const assigned = () => watches.filter((entry) => entry.watch).map((entry) => [entry.channel, entry.watch!.term] as const);
  return {
    hub, watches, reachable, state, sqlite, sockets, puts, alarm: () => alarm, alarms: () => alarms, alarmHistory,
    // The runtime has cleared the alarm by the time its handler runs.
    clearAlarm: () => { alarm = null; },
    drain: async () => { while (pending.length) await pending.shift(); },
    connectionId: connection.id, power, changes, watched, facts, assigned,
  };
}

const NOON = "2026-10-21T09:00:00.000Z";
type Entry = [entity: string, state: string, lastChanged: string, lastUpdated?: string | null, attributes?: Record<string, unknown>];
const states = (term: number, connection: string, list: Entry[], full = true) => ({
  method: "ha.states" as const,
  params: {
    term,
    connection,
    full,
    states: list.map(([entity_id, state, last_changed, last_updated, attributes]) => ({
      entity_id, state, last_changed, last_updated: last_updated ?? null, attributes: attributes ?? {},
    })),
  },
});
const status = (term: number, connection: string, connected: boolean) => ({
  method: "ha.status" as const,
  params: { term, connection, connected, error: connected ? null : "refused" },
});

describe("HA-confirmed power announcements", () => {
  const connectBot = (sockets: any[], receive: (event: any) => void) => sockets.push({
    tags: ["bot"],
    deserializeAttachment: () => ({ kind: "bot", reminderLeadMs: null }),
    send(data: string) {
      const frame = JSON.parse(data);
      if (frame.event === "shop.event") receive(frame.data);
    },
  });

  for (const shared of [false, true]) it(`announces confirmed on/off changes once to every Bot, with shared power=${shared}`, async () => {
    const { hub, sockets, sqlite, connectionId, power } = await fixture();
    const events: any[] = [];
    const other: any[] = [];
    connectBot(sockets, (event) => {
      expect(power().filter((row) => JSON.parse(row.value_json) === event.state)).toHaveLength(shared ? 2 : 1);
      events.push(event);
    });
    connectBot(sockets, (event) => other.push(event));
    try {
      if (shared) sqlite.run("UPDATE device_capabilities SET config_json=? WHERE device_id='m2' AND capability='power'",
        [JSON.stringify({ connectionId, entityId: "switch.a" })]);
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.relayOnline(SHOP, "b", "chan-b");
      const initial: Entry = ["switch.a", "off", NOON];
      await hub.haReport(SHOP, "a", states(1, connectionId, [initial]));
      await hub.haReport(SHOP, "b", states(2, connectionId, [initial]));
      expect(events).toEqual([]);
      const on: Entry = ["switch.a", "on", "2026-10-21T09:01:00.000Z"];
      await Promise.all([
        hub.haReport(SHOP, "a", states(1, connectionId, [on], false)),
        hub.haReport(SHOP, "b", states(2, connectionId, [on], false)),
      ]);
      // A delayed event and an attribute-only change do not announce again.
      await hub.haReport(SHOP, "b", states(2, connectionId, [initial], false));
      await hub.haReport(SHOP, "a", states(1, connectionId,
        [[on[0], on[1], on[2], "2026-10-21T09:02:00.000Z", { friendly_name: "Power" }]], false));
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:03:00.000Z"]], false));
      expect(events).toEqual(["on", "off"].map((state, index) => ({
        kind: "power", resourceId: "m1", resourceName: shared ? "m1、m2" : "m1", state, by: "ha", player: null,
        at: `2026-10-21T09:0${index ? 3 : 1}:00.000Z`,
      })));
      expect(other).toEqual(events);
    } finally { sqlite.close(); }
  });

  it("announces shared air conditioners only when switching between off and running modes", async () => {
    const { hub, sockets, sqlite, connectionId } = await fixture({ climate: true });
    const events: any[] = [];
    connectBot(sockets, (event) => events.push(event));
    try {
      sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,aliases_json) VALUES (?,'m4','pub-m4','m4','[]')", [SHOP]);
      sqlite.run("INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) SELECT shop_id,'m4',capability,config_json,secret_json,created_at,updated_at FROM device_capabilities WHERE device_id='m3'");
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.relayOnline(SHOP, "b", "chan-b");
      const report = (mode: string, minute: number, full = false, watcher = "a", term = 1) => hub.haReport(SHOP, watcher,
        states(term, connectionId, [["climate.c", mode, `2026-10-21T09:0${minute}:00.000Z`]], full));
      await report("off", 0, true);
      await report("off", 0, true, "b", 2);
      expect(events).toEqual([]);
      await Promise.all([report("cool", 1), report("cool", 1, false, "b", 2)]);
      await report("heat", 2);
      await hub.haReport(SHOP, "a", states(1, connectionId,
        [["climate.c", "heat", "2026-10-21T09:02:00.000Z", "2026-10-21T09:03:00.000Z", { temperature: 24, current_temperature: 27 }]], false));
      expect(events).toHaveLength(1);
      await report("off", 4);
      await report("unavailable", 5);
      await report("cool", 6);
      await report("unknown", 7);
      await report("heat", 8);
      expect(events).toEqual(["on", "off"].map((state, index) => ({
        kind: "power", resourceId: "m3", resourceName: "m3、m4", state, by: "ha", player: null,
        at: `2026-10-21T09:0${index ? 4 : 1}:00.000Z`,
      })));
    } finally { sqlite.close(); }
  });

  it("does not announce snapshots, unready or stale watchers, unknown states or changes during a disconnect", async () => {
    const { hub, sockets, sqlite, connectionId } = await fixture();
    const events: any[] = [];
    connectBot(sockets, (event) => events.push(event));
    try {
      await hub.relayOnline(SHOP, "a", "chan-a");
      const report = (state: string, minute: number, full = false, term = 1, watcher = "a") => hub.haReport(SHOP, watcher,
        states(term, connectionId, [["switch.a", state, `2026-10-21T09:0${minute}:00.000Z`]], full));
      await report("off", 0);
      await report("on", 1);
      await report("off", 2, true);
      await report("on", 3, false, 0);
      await report("on", 3, false, 1, "unassigned");
      await hub.haReport(SHOP, "a", status(1, connectionId, false));
      await hub.haReport(SHOP, "a", status(1, connectionId, true));
      await report("on", 3, true);
      await report("unavailable", 4);
      await report("off", 5);
      await report("unknown", 6);
      await report("on", 7);
      expect(events).toEqual([]);
      await report("off", 8);
      expect(events).toEqual([expect.objectContaining({ kind: "power", state: "off", by: "ha" })]);
    } finally { sqlite.close(); }
  });

  it("does not announce a power change that failed to persist", async () => {
    const { hub, sockets, sqlite, connectionId } = await fixture();
    const events: any[] = [];
    connectBot(sockets, (event) => events.push(event));
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", NOON]]));
      sqlite.run("ALTER TABLE device_state RENAME TO device_state_away");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", "2026-10-21T09:01:00.000Z"]], false));
      expect(events).toEqual([]);
    } finally { quiet.mockRestore(); sqlite.close(); }
  });
});

describe("ShopHub watchers", () => {
  it("reissues a persisted assignment immediately to a reconnect, but preserves the term on ordinary heartbeats", async () => {
    const { hub, assigned, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a", { session: "before-deploy" });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    await hub.relayOnline(SHOP, "a", "chan-a", { session: "after-deploy" });
    expect(assigned()).toEqual([["chan-a", 1], ["chan-a", 2]]);
    await hub.relayOffline(SHOP, "a", { session: "before-deploy" });
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["a"]);
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect((state.get("watchers") as Record<string, { links: object }>).a!.links).toEqual({});
    await hub.relayOnline(SHOP, "a", "chan-a", { session: "after-deploy" });
    expect(assigned()).toHaveLength(2);
    await hub.relayOnline(SHOP, "a", "chan-a", { session: "after-deploy", restart: true });
    expect(assigned().at(-1)).toEqual(["chan-a", 3]);
  });

  for (const trigger of ["read", "alarm"] as const) it(`withdraws and replaces an offline IO through the relay ${trigger}, even before its HA lease expires`, async () => {
    const { hub, state, sqlite, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.relayOnline(SHOP, "m3", "chan-b");
    await hub.relayOnline(SHOP, "m2", "chan-c");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON]]));
    await hub.poweredOff(SHOP, "m1");
    expect((await (hub as any).watchersFrame(state.get("watchers"))).watchers.find((w: { id: string }) => w.id === "m1").state).toBe("confirming");
    const stored = new Map<string, unknown>([
      ["online", true], ["channel", { shopId: SHOP, machineId: "m1", channel: "chan-a" }],
    ]);
    const attachment = { role: "agent", ha: true, seenAt: Date.now() - 151_000 };
    const socket = { readyState: 1, deserializeAttachment: () => attachment };
    const relay = new MachineRelay({
      storage: {
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: unknown) => { stored.set(key, value); },
        deleteAlarm: async () => {},
      },
      getWebSockets: () => [socket],
    } as any, {
      DB: createD1DatabaseFromSqlite(sqlite), SHOP_HUB: { getByName: () => hub },
    } as any);
    if (trigger === "read") expect((await relay.getCapabilities()).online).toBe(false);
    else await relay.alarm();
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["m2", "m3"]);
    expect((state.get("candidates") as Record<string, unknown>).m1).toBeUndefined();
  });

  it("gives the watch to the two IOs online longest, with the shop-local address first", async () => {
    const { hub, watches, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    expect(assigned()).toEqual([["chan-a", 1], ["chan-b", 2]]);
    expect(watches[0]).toEqual({
      channel: "chan-a",
      watch: {
        term: 1,
        connections: [{ id: connectionId, urls: ["http://ha.local:8123", "https://ha.example"], token: "reader", entities: ["switch.a", "switch.b"] }],
      },
    });
  });

  it("records only reports from a current watcher and term, at the time Home Assistant gives", async () => {
    const { hub, power, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    // c is not watching, and term 0 is not an assignment a has.
    await hub.haReport(SHOP, "c", states(3, connectionId, [["switch.a", "on", NOON]]));
    await hub.haReport(SHOP, "a", states(0, connectionId, [["switch.a", "on", NOON]]));
    expect(power()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", "2026-10-21T08:00:00.000Z"]]));
    expect(power()).toEqual([
      { device_id: "m1", value_json: '"on"', changed_at: NOON },
      { device_id: "m2", value_json: '"off"', changed_at: "2026-10-21T08:00:00.000Z" },
    ]);
  });

  it("announces a connection only once a watcher has delivered its full state", async () => {
    const { hub, watched, facts, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(watched()).toEqual([]);
    // Subscribed but nothing stored yet: still not watched.
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect(watched()).toEqual([]);
    expect(await facts("m1")).toEqual({ watching: false, power: null, climate: null });
    // An incremental report is not the full state.
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]], false));
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", NOON]]));
    expect(watched()).toEqual([connectionId]);
    expect(await facts("m1")).toEqual({ watching: true, power: "on", climate: null });
    expect(await facts("m2")).toEqual({ watching: true, power: "off", climate: null });
  });

  it("does not announce a snapshot it could not store, and asks the IO to subscribe again", async () => {
    const { hub, watched, sqlite, assigned, connectionId } = await fixture();
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await hub.relayOnline(SHOP, "a", "chan-a");
      sqlite.run("ALTER TABLE device_state RENAME TO device_state_away");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
      expect(watched()).toEqual([]);
      // A new term makes the IO send the full state again.
      expect(assigned()).toEqual([["chan-a", 1], ["chan-a", 2]]);
      sqlite.run("ALTER TABLE device_state_away RENAME TO device_state");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
      expect(watched()).toEqual([]);
      await hub.haReport(SHOP, "a", states(2, connectionId, [["switch.a", "on", NOON]]));
      expect(watched()).toEqual([connectionId]);
    } finally { quiet.mockRestore(); }
  });

  it("keeps the state flowing when one of two watchers leaves, and fills the slot from a spare", async () => {
    const { hub, watched, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    for (const [machine, term] of [["a", 1], ["b", 2]] as const)
      await hub.haReport(SHOP, machine, states(term, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    await hub.relayOffline(SHOP, "a");
    // b still carries it, and c took a's place under a new term.
    expect(watched()).toEqual([connectionId]);
    expect(assigned().at(-1)).toEqual(["chan-c", 3]);
    await hub.relayOffline(SHOP, "b");
    // c has not delivered its state yet, so nothing is watched until it does.
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "c", states(3, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    await hub.relayOffline(SHOP, "c");
    expect(watched()).toEqual([]);
    expect(await hub.watching()).toEqual([]);
  });

  it("drops a watcher that went quiet past its lease and withdraws what only it carried", async () => {
    const { hub, state, reachable, watched, facts, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    const watchers = state.get("watchers") as Record<string, { leaseUntil: number }>;
    watchers.a!.leaseUntil = Date.now() - 1;
    state.set("watchers", watchers);
    // Nobody else is online and the IO cannot be told: nothing watches any more.
    reachable.delete("chan-a");
    await hub.alarm();
    expect(watched()).toEqual([]);
    // The stored value stays but is no longer a fact.
    expect(await facts("m1")).toEqual({ watching: false, power: null, climate: null });
  });

  /** The read-only account maker, with the moment it finishes and what it leaves behind in the test's hands. */
  const readAccessMaker = (hub: ShopHub, db: ReturnType<typeof createD1DatabaseFromSqlite>, outcome: "ready" | "needs_admin") => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (hub as any).provision = async (_db: unknown, shop: string, id: string) => {
      started.push(id);
      await gate;
      const stored = (await getHaConnection(db, shop, id))!;
      await writeHaConnection(db, shop, outcome === "ready"
        ? { ...stored, readToken: await encryptSecret("reader", KEY), readAccess: "ready" }
        : { ...stored, readAccess: "needs_admin" }).run();
      return { access: outcome, error: null };
    };
    return { started, release };
  };
  const settled = async (done: () => boolean) => {
    for (let waited = 0; waited < 500 && !done(); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  it("makes the read-only account for a connection that never had one, once, then starts the watch", async () => {
    const { hub, sqlite, assigned, watches, connectionId } = await fixture({ legacy: true });
    const maker = readAccessMaker(hub, createD1DatabaseFromSqlite(sqlite), "ready");
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    // Both IOs are here and the account is still being made: it is not made twice, and nothing watches yet.
    expect(maker.started).toEqual([connectionId]);
    expect(assigned()).toEqual([]);
    maker.release();
    await settled(() => assigned().length === 2);
    expect(maker.started).toEqual([connectionId]);
    expect(assigned().map(([channel]) => channel).sort()).toEqual(["chan-a", "chan-b"]);
    const watch = watches.find((entry) => entry.watch)!.watch!;
    expect(watch.connections.map((connection) => [connection.id, connection.token])).toEqual([[connectionId, "reader"]]);
  });

  it("does not try again for a connection whose account could not be made", async () => {
    const { hub, sqlite, assigned, connectionId } = await fixture({ legacy: true });
    const maker = readAccessMaker(hub, createD1DatabaseFromSqlite(sqlite), "needs_admin");
    maker.release();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await settled(() => maker.started.length > 0 && (hub as any).makingReadAccess.size === 0);
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.alarm();
    expect(maker.started).toEqual([connectionId]);
    expect(assigned()).toEqual([]);
  });

  it("makes no account for a connection no device uses", async () => {
    const { hub, sqlite } = await fixture({ legacy: true });
    const maker = readAccessMaker(hub, createD1DatabaseFromSqlite(sqlite), "ready");
    sqlite.run("DELETE FROM device_capabilities");
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(maker.started).toEqual([]);
  });

  it("settles what is due before scheduling, so the next alarm is never set in the past", async () => {
    const { hub, state, alarmHistory, clearAlarm, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    // An idle check that has come due. Scheduling while it is still pending would set an alarm in
    // the past, which fires again at once; on a runtime that drops an alarm set to the time of the
    // one running, nothing would then wake for the watcher's lease.
    state.set("touchAt", Date.now() - 1);
    clearAlarm();
    alarmHistory.length = 0;
    await hub.alarm();
    const now = Date.now();
    expect(alarmHistory.length).toBeGreaterThan(0);
    expect(alarmHistory.every((at) => at > now)).toBe(true);
    expect(state.get("touchAt")).toBeUndefined();
  });

  it("replaces a quiet watcher with one that can be told", async () => {
    const { hub, state, assigned } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    const watchers = state.get("watchers") as Record<string, { leaseUntil: number }>;
    watchers.a!.leaseUntil = Date.now() - 1;
    state.set("watchers", watchers);
    await hub.alarm();
    expect(assigned().at(-1)).toEqual(["chan-c", 3]);
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["b", "c"]);
  });

  it("hands over when a watcher cannot reach Home Assistant and another IO can try", async () => {
    const { hub, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    await hub.haReport(SHOP, "a", status(1, connectionId, false));
    expect(assigned().at(-1)).toEqual(["chan-c", 3]);
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["b", "c"]);
  });

  it("stops announcing a connection its only watcher cannot reach, without giving up the watch", async () => {
    const { hub, watched, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    await hub.haReport(SHOP, "a", status(1, connectionId, false));
    expect(watched()).toEqual([]);
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["a"]);
    // Back again: subscribed, and the full state comes with it.
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", NOON]]));
    expect(watched()).toEqual([connectionId]);
  });

  it("keeps the watch when a machine loses power, and brings in cover while it is out", async () => {
    // Power off says the machine is dark, not that its IO is. Taking the watch
    // away would throw away an assignment that may still be perfectly good, so
    // it is kept and the IO's own reports decide what happens next.
    const { hub, watches } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    await hub.poweredOff(SHOP, "a");
    // Nobody was told to stop...
    expect(watches.filter((entry) => entry.watch === null)).toHaveLength(0);
    // ...and a third watcher covers the machine that went dark.
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["a", "b", "c"]);
  });

  it("brings in cover when Home Assistant reports the power off, without taking the watch away", async () => {
    // The same event whichever path noticed it: an observation opens, the
    // assignment stays. m1 and m2 own the switches; m1 and m3 are watching.
    const { hub, watches, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.relayOnline(SHOP, "m3", "chan-b");
    await hub.relayOnline(SHOP, "m2", "chan-c");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:00:00.000Z"]], false));
    expect(watches.filter((entry) => entry.watch === null)).toHaveLength(0);
    // m2 comes in alongside m1 and m3 while m1's IO is unaccounted for.
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("does not release the watch for unavailable, or for a machine that was already off", async () => {
    const { hub, watches, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.relayOnline(SHOP, "m3", "chan-b");
    await hub.relayOnline(SHOP, "m2", "chan-c");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    // A Home Assistant hiccup is not a power-off.
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "unavailable", "2026-10-21T10:00:00.000Z"]], false));
    expect(watches.filter((entry) => entry.channel === "chan-a" && entry.watch === null)).toHaveLength(0);
    // Off, then off again: only the transition counts.
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:10:00.000Z"]], false));
    const released = watches.filter((entry) => entry.channel === "chan-a" && entry.watch === null).length;
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:20:00.000Z"]], false));
    expect(watches.filter((entry) => entry.channel === "chan-a" && entry.watch === null).length).toBe(released);
  });

  it("learns that an IO survives its machine being switched off, after watching it do so", async () => {
    // The platform cannot see how an IO is powered, so it watches what the IO
    // does across a power-off. Reporting throughout, with Home Assistant saying
    // the machine is off, is what "does not die with its machine" looks like.
    const { hub, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:00:00.000Z"]], false));
    // Still reporting, still the same term: that is the whole observation.
    await hub.haReport(SHOP, "m1", status(1, connectionId, true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const observations = state.get("observations") as Record<string, { startedAt: number }>;
    await hub.haReport(SHOP, "m1", status(1, connectionId, true));
    // Move the window's start back so the next alarm settles it.
    observations.m1!.startedAt = Date.now() - 4 * 60_000;
    state.set("observations", observations);
    await hub.alarm();
    expect((state.get("reliability") as Record<string, { trusted: boolean }>).m1!.trusted).toBe(true);
  });

  it("does not trust an IO that stopped reporting after its machine went off", async () => {
    const { hub, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.relayOnline(SHOP, "m2", "chan-b");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON]]));
    await hub.poweredOff(SHOP, "m1", { confirmed: true });
    // The IO goes quiet and its lease runs out; that is a failure against the
    // power-off, and the platform records it as such without claiming to know why.
    const watchers = state.get("watchers") as Record<string, { leaseUntil: number }>;
    watchers.m1!.leaseUntil = Date.now() - 1;
    state.set("watchers", watchers);
    const observations = state.get("observations") as Record<string, { startedAt: number }>;
    observations.m1!.startedAt = Date.now() - 4 * 60_000;
    state.set("observations", observations);
    await hub.alarm();
    const learned = (state.get("reliability") as Record<string, { trusted: boolean; consecutiveFailures: number }>).m1!;
    expect(learned.consecutiveFailures).toBe(1);
    expect(learned.trusted).toBe(false);
  });

  it("stops trusting the only watcher's word when its machine goes off, and trusts it again when it speaks", async () => {
    // Not a release: the assignment and its term are kept and no unwatch is
    // sent. What stops is treating its last snapshot as the present, because the
    // machine it lives in just went dark.
    const { hub, watches, watched, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);
    // Home Assistant reports the power off. This very report must not count as
    // proof of life.
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:00:00.000Z"]], false));
    expect(watched()).toEqual([]);
    // Nothing was taken away: same watcher, same term, and no unwatch sent.
    expect(watches.filter((entry) => entry.watch === null)).toHaveLength(0);
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["m1"]);
    // A later report on the same assignment puts it back.
    await hub.haReport(SHOP, "m1", status(1, connectionId, true));
    expect(watched()).toEqual([connectionId]);
  });

  it("counts one power-off once, however many times it is reported", async () => {
    // The platform's own command and Home Assistant's report of the state change
    // are the same power-off arriving twice; it must not become two observations
    // or two failures.
    const { hub, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    await hub.poweredOff(SHOP, "m1");
    const first = (state.get("observations") as Record<string, { startedAt: number }>).m1!.startedAt;
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:00:00.000Z"]], false));
    await hub.poweredOff(SHOP, "m1");
    expect((state.get("observations") as Record<string, { startedAt: number }>).m1!.startedAt).toBe(first);
  });

  it("does not count a power-off as a success or a failure when the machine comes back", async () => {
    const { hub, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    await hub.poweredOff(SHOP, "m1", { confirmed: true });
    // Switched back on before the window closed.
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", "2026-10-21T10:00:00.000Z"]], false));
    const observations = state.get("observations") as Record<string, { startedAt: number; result?: string }>;
    observations.m1!.startedAt = Date.now() - 4 * 60_000;
    state.set("observations", observations);
    await hub.alarm();
    const settled = (state.get("observations") as Record<string, { result?: string }>).m1!;
    expect(settled.result).toBe("inconclusive");
    // Nothing was learnt either way.
    expect((state.get("reliability") as Record<string, unknown> | undefined)?.m1).toBeUndefined();
  });

  it("covers even a trusted IO until it reports after the power-off, then retires the spare", async () => {
    const { hub, state, connectionId, watches } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    await hub.relayOnline(SHOP, "c", "chan-c");
    state.set("reliability", { a: { trusted: true, consecutiveFailures: 0 } });
    await hub.poweredOff(SHOP, "a");
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["a", "b", "c"]);
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["a", "b"]);
    expect(watches.at(-1)).toEqual({ channel: "chan-c", watch: null });
  });

  it("fills again when the temporary watcher also powers off, without ending either observation", async () => {
    const { hub, state, watches, assigned, connectionId, watched } = await fixture();
    state.set("limit", 1);
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.relayOnline(SHOP, "m2", "chan-b");
    await hub.relayOnline(SHOP, "m3", "chan-c");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    await hub.poweredOff(SHOP, "m1");
    await hub.haReport(SHOP, "m2", states(2, connectionId, [["switch.a", "off", "2026-10-21T10:00:00Z"], ["switch.b", "on", NOON]]));
    expect(watched()).toEqual([connectionId]);

    await hub.poweredOff(SHOP, "m2");
    expect(assigned()).toEqual([["chan-a", 1], ["chan-b", 2], ["chan-c", 3]]);
    expect(watches.filter((entry) => entry.watch === null)).toHaveLength(0);
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "m3", states(3, connectionId, [["switch.a", "off", "2026-10-21T10:00:00Z"], ["switch.b", "off", "2026-10-21T10:01:00Z"]]));
    expect(watched()).toEqual([connectionId]);

    await hub.haReport(SHOP, "m1", status(1, connectionId, true));
    expect((await hub.watching()).map((entry) => entry.machineId).sort()).toEqual(["m1", "m2"]);
    expect(watched()).toEqual([connectionId]);
  });

  it("replaces pending watchers even with the shop's limit already at four", async () => {
    const { hub, state, reachable, assigned } = await fixture();
    state.set("limit", 4);
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      reachable.add(`chan-${id}`);
      await hub.relayOnline(SHOP, id, `chan-${id}`);
    }
    await hub.poweredOff(SHOP, "a");
    await hub.poweredOff(SHOP, "e");
    expect(assigned().map(([channel]) => channel)).toEqual(["chan-a", "chan-b", "chan-c", "chan-d", "chan-e", "chan-f"]);
    expect(await hub.watching()).toHaveLength(6);
  });

  it("holds shared-power watchers and excludes their standby peers before filling", async () => {
    const { hub, sqlite, state, connectionId, assigned, watched, watches } = await fixture();
    state.set("limit", 1);
    sqlite.run("UPDATE device_capabilities SET config_json=? WHERE device_id='m2' AND capability='power'", [JSON.stringify({ connectionId, entityId: "switch.a" })]);
    await hub.relayOnline(SHOP, "m2", "chan-a");
    await hub.relayOnline(SHOP, "m1", "chan-b");
    await hub.relayOnline(SHOP, "m3", "chan-c");
    await hub.haReport(SHOP, "m2", states(1, connectionId, [["switch.a", "on", NOON]]));

    // The command's target need not itself be a watcher or even have an IO.
    await hub.poweredOff(SHOP, "m1");
    expect(watched()).toEqual([]);
    expect(assigned()).toEqual([["chan-a", 1], ["chan-c", 2]]);
    expect((state.get("watchers") as Record<string, { held?: number }>).m2!.held).toBeDefined();
    expect(watches.filter((entry) => entry.watch === null)).toHaveLength(0);

    await hub.relayOffline(SHOP, "m3");
    expect(assigned()).toHaveLength(2);
    // A new heartbeat/hello proves that the standby IO survived the power-off.
    await hub.relayOnline(SHOP, "m1", "chan-b");
    expect(assigned().at(-1)).toEqual(["chan-b", 3]);
  });

  it("holds both watchers of a shared entity before selecting cover for an HA power-off", async () => {
    const { hub, sqlite, state, connectionId, assigned, power, watched } = await fixture();
    sqlite.run("UPDATE device_capabilities SET config_json=? WHERE device_id='m2' AND capability='power'", [JSON.stringify({ connectionId, entityId: "switch.a" })]);
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.relayOnline(SHOP, "m2", "chan-b");
    await hub.relayOnline(SHOP, "m3", "chan-c");
    for (const [id, term] of [["m1", 1], ["m2", 2]] as const)
      await hub.haReport(SHOP, id, states(term, connectionId, [["switch.a", "on", NOON]]));
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "off", "2026-10-21T10:00:00Z"]], false));
    const watchers = state.get("watchers") as Record<string, { held?: number }>;
    expect(watchers.m1!.held).toBeDefined();
    expect(watchers.m2!.held).toBeDefined();
    expect(assigned()).toEqual([["chan-a", 1], ["chan-b", 2], ["chan-c", 3]]);
    expect(power().map((row) => [row.device_id, JSON.parse(row.value_json)])).toEqual([["m1", "off"], ["m2", "off"]]);
    expect(watched()).toEqual([]);
  });

  it("does not lift a power-off hold with a heartbeat already queued before it", async () => {
    const { hub, connectionId, watched } = await fixture();
    await hub.relayOnline(SHOP, "m1", "chan-a");
    await hub.haReport(SHOP, "m1", states(1, connectionId, [["switch.a", "on", NOON]]));
    let unblock!: () => void;
    (hub as any).reports = new Promise<void>((resolve) => { unblock = resolve; });
    const old = hub.haReport(SHOP, "m1", status(1, connectionId, true));
    try {
      await hub.poweredOff(SHOP, "m1");
    } finally { unblock(); }
    await old;
    expect(watched()).toEqual([]);
    await hub.haReport(SHOP, "m1", status(1, connectionId, true));
    expect(watched()).toEqual([connectionId]);
  });

  it("keeps a standby's failure cooldown and priority when its next heartbeat offers it again", async () => {
    const { hub, state, assigned } = await fixture();
    state.set("limit", 1);
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    const candidates = state.get("candidates") as Record<string, { since: number; benchedUntil?: number }>;
    candidates.b!.benchedUntil = Date.now() + 300_000;
    state.set("candidates", candidates);
    await hub.relayOnline(SHOP, "b", "chan-b");
    expect(state.get("candidates")).toEqual(candidates);
    expect(assigned()).toEqual([["chan-a", 1]]);
  });

  it("skips an IO that could not be told and tries the next", async () => {
    const { hub, reachable, assigned } = await fixture();
    reachable.delete("chan-a");
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(await hub.watching()).toEqual([]);
    await hub.relayOnline(SHOP, "b", "chan-b");
    // The open second slot still retries a, which cannot be told, after b.
    expect(assigned().map(([channel]) => channel)).toContain("chan-b");
    expect((await hub.watching()).map((entry) => entry.machineId)).toEqual(["b"]);
  });

  it("stores an event the second watcher also saw once, and ignores one that arrives out of order", async () => {
    const { hub, power, changes, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    const on = ["switch.a", "on", "2026-10-21T09:00:00.000Z", "2026-10-21T09:00:00.000Z"] as Entry;
    const off = ["switch.a", "off", "2026-10-21T09:05:00.000Z", "2026-10-21T09:05:00.000Z"] as Entry;
    await hub.haReport(SHOP, "a", states(1, connectionId, [on]));
    await hub.haReport(SHOP, "b", states(2, connectionId, [on]));
    expect(changes("power")).toHaveLength(1);
    await hub.haReport(SHOP, "a", states(1, connectionId, [off], false));
    // b sees the same event, and also the older one late.
    await hub.haReport(SHOP, "b", states(2, connectionId, [off], false));
    await hub.haReport(SHOP, "b", states(2, connectionId, [on], false));
    expect(power()).toEqual([{ device_id: "m1", value_json: '"off"', changed_at: "2026-10-21T09:05:00.000Z" }]);
    expect(changes("power").map((row) => JSON.parse(row.payload_json).to)).toEqual(["on", "off"]);
  });

  it("stores an unavailable entity as unknown rather than leaving its last value", async () => {
    const { hub, facts, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    expect((await facts("m1")).power).toBe("on");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "unavailable", "2026-10-21T09:10:00.000Z", "2026-10-21T09:10:00.000Z"]], false));
    expect(await facts("m1")).toEqual({ watching: true, power: null, climate: null });
  });

  it("keeps an air conditioner's full view up to date but logs only its setting", async () => {
    const { hub, facts, changes, connectionId, sqlite, state } = await fixture({ climate: true });
    await hub.relayOnline(SHOP, "a", "chan-a");
    const attributes = (current: number, temperature = 24) => ({
      hvac_modes: ["off", "cool"], temperature, current_temperature: current, fan_mode: "low", fan_modes: ["auto", "low"],
      min_temp: 16, max_temp: 30, target_temp_step: 1,
    });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, NOON, attributes(27)]]));
    expect((await facts("m3")).climate).toMatchObject({ mode: "cool", temperature: 24, currentTemperature: 27 });
    // Room temperature drifts: the view follows, the log does not.
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, "2026-10-21T09:01:00.000Z", attributes(28)]], false));
    expect((await facts("m3")).climate).toMatchObject({ currentTemperature: 28 });
    expect(changes("climate")).toHaveLength(1);
    expect((sqlite.query("SELECT changed_at FROM device_state WHERE device_id='m3' AND key='climate'").get() as any).changed_at).toBe(NOON);
    state.delete("touchAt");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, "2026-10-21T09:02:00.000Z", attributes(28, 22)]], false));
    expect((await facts("m3")).climate).toMatchObject({ temperature: 22 });
    expect(changes("climate")).toHaveLength(2);
    expect((sqlite.query("SELECT changed_at FROM device_state WHERE device_id='m3' AND key='climate'").get() as any).changed_at).toBe("2026-10-21T09:02:00.000Z");
    expect(state.has("touchAt")).toBe(true);
  });

  it("rewrites every fact after the devices an entity drives changed, without un-announcing the connection", async () => {
    const { hub, sqlite, watched, facts, assigned, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    sqlite.run("DELETE FROM device_state");
    await hub.refresh(SHOP);
    expect(assigned().at(-1)).toEqual(["chan-a", 2]);
    expect(watched()).toEqual([connectionId]);
    // The same state again is rewritten, because what was known about it was dropped.
    await hub.haReport(SHOP, "a", states(2, connectionId, [["switch.a", "on", NOON, NOON]]));
    expect((await facts("m1")).power).toBe("on");
  });

  it("writes one row per heartbeat and wakes only when the lease could lapse", async () => {
    const { hub, puts, alarms, state, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
    const before = { puts: puts.length, alarms: alarms() };
    await hub.haReport(SHOP, "a", status(1, connectionId, true));
    expect(puts.slice(before.puts)).toEqual(["watchers"]);
    expect(alarms()).toBe(before.alarms);
    expect((state.get("watchers") as Record<string, { leaseUntil: number }>).a!.leaseUntil).toBeGreaterThan(Date.now() + LEASE_MS - 5_000);
  });
});

describe("ShopHub device pages", () => {
  class PageSocket {
    /** Everything sent to it, in order. */
    readonly all: any[] = [];
    /** What it was sent about devices. The board's watcher list is asserted on its own, in `watchers`. */
    get sent() { return this.all.filter((frame) => frame.type !== "watchers"); }
    get watchers() { return this.all.filter((frame) => frame.type === "watchers"); }
    attachment: unknown = null;
    tags: string[] = [];
    send(data: string) { this.all.push(JSON.parse(data)); }
    close() {}
    serializeAttachment(value: unknown) { this.attachment = value; }
    deserializeAttachment() { return this.attachment; }
  }
  const open = async (hub: ShopHub, deviceId: string, userId = "u1") => {
    (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
    try {
      const response = await hub.fetch(new Request("https://prism.test/api/v1/devices/session/ws", {
        headers: { Upgrade: "websocket", "x-prism-hub-shop": SHOP, "x-prism-hub-device": deviceId, "x-prism-hub-user": userId },
      }));
      expect(response.status).toBe(101);
    } finally {
      delete (globalThis as any).WebSocketPair;
    }
  };

  /**
   * Home Assistant as a device that nothing watches is read: it says the opposite of what
   * the watcher will report, so a frame shows where its value came from.
   */
  let ha: ReturnType<typeof spyOn> | null = null;
  /** Every entity Home Assistant was asked for, in order. */
  const asked: string[] = [];
  beforeEach(() => {
    asked.length = 0;
    ha = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/api/states/")) asked.push(path.slice("/api/states/".length));
      if (path === "/api/states/switch.a" || path === "/api/states/switch.b") return Response.json({ state: "off" });
      return new Response("", { status: 404 });
    }) as typeof fetch);
  });
  afterEach(() => { ha?.mockRestore(); ha = null; });

  it("tells a page its device's state from Home Assistant while nothing watches it, and from the watcher once it does", async () => {
    const { hub, sockets, connectionId, drain } = await fixture();
    await open(hub, "m1");
    const page = sockets[0] as PageSocket;
    // The greeting does not wait on Home Assistant; its answer follows.
    expect(page.sent).toEqual([{ type: "hello", watching: false }]);
    await drain();
    expect(page.sent).toEqual([{ type: "hello", watching: false }, { type: "state", power: "off" }]);
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(page.sent).toHaveLength(2);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", NOON]]));
    // The first snapshot is not the device's state until the connection is announced; then it is, once.
    expect(page.sent.slice(2)).toEqual([{ type: "watching", watching: true, power: "on" }]);
    await open(hub, "m1");
    expect((sockets[1] as PageSocket).sent).toEqual([{ type: "hello", watching: true, power: "on" }]);
    // Nobody reports its changes any more, so Home Assistant is asked and the page told.
    await hub.relayOffline(SHOP, "a");
    expect(page.sent.at(-1)).toEqual({ type: "watching", watching: false, power: "off" });
  });

  it("passes what the backend read of a device that is not live to its pages and the boards, and ignores it for a live one", async () => {
    const { hub, sockets, connectionId, drain } = await fixture();
    await open(hub, "m1");
    await openBoard(hub);
    await drain();
    const [page, board] = sockets as PageSocket[];
    await hub.deviceRead(SHOP, "m1", { power: "on" });
    expect(page!.sent.at(-1)).toEqual({ type: "state", power: "on" });
    expect(board!.sent.at(-1)).toEqual({ type: "state", deviceId: "m1", power: "on" });
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", NOON]]));
    const pageSent = page!.sent.length;
    const boardSent = board!.sent.length;
    await hub.deviceRead(SHOP, "m1", { power: "off" });
    expect(page!.sent).toHaveLength(pageSent);
    expect(board!.sent).toHaveLength(boardSent);
  });

  it("tells a page when its own device switches, and only that device", async () => {
    const { hub, sockets, connectionId } = await fixture();
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON], ["switch.b", "on", NOON, NOON]]));
    await open(hub, "m1");
    await open(hub, "m2");
    const [one, two] = sockets as PageSocket[];
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false));
    expect(one!.sent.at(-1)).toEqual({ type: "state", power: "off" });
    expect(two!.sent).toEqual([{ type: "hello", watching: true, power: "on" }]);
  });

  it("reaches only the pages of the user it names", async () => {
    const { hub, sockets, drain } = await fixture();
    await open(hub, "m1", "u1");
    await open(hub, "m1", "u2");
    await drain();
    await hub.notifyUser("u1", { type: "refresh", reason: "binding" });
    const [first, second] = sockets as PageSocket[];
    expect(first!.sent.at(-1)).toEqual({ type: "refresh", reason: "binding" });
    expect(second!.sent).toEqual([{ type: "hello", watching: false }, { type: "state", power: "off" }]);
    // Two pages of the same device opening together share one read.
    expect(asked).toEqual(["switch.a"]);
  });

  it("drops a Home Assistant answer that comes back after the device became live", async () => {
    const { hub, sockets, connectionId, drain } = await fixture();
    // Home Assistant is slow to answer, and the watcher's snapshot gets in first.
    let answer!: () => void;
    const held = new Promise<void>((done) => { answer = done; });
    ha?.mockImplementation((async () => {
      await held;
      return Response.json({ state: "off" });
    }) as unknown as typeof fetch);
    await open(hub, "m1");
    await openBoard(hub);
    const [page, board] = sockets as PageSocket[];
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "on", NOON]]));
    expect(page!.sent.at(-1)).toEqual({ type: "watching", watching: true, power: "on" });
    const live = board!.sent.length;
    answer();
    await drain();
    // The older answer would have labelled the devices not live and shown the switches off.
    expect(page!.sent.at(-1)).toEqual({ type: "watching", watching: true, power: "on" });
    expect(board!.sent).toHaveLength(live);
  });

  it("asks Home Assistant only while a page or a board is open, once per device for all of them", async () => {
    const { hub, sockets, connectionId, drain } = await fixture();
    // Nobody is looking: a connection starting and stopping asks Home Assistant nothing.
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON], ["switch.b", "off", NOON]]));
    await hub.relayOffline(SHOP, "a");
    expect(asked).toEqual([]);
    // A page of m1 and a board open together: each device is asked once, m1 for both of them.
    await open(hub, "m1");
    await openBoard(hub);
    await drain();
    expect([...asked].sort()).toEqual(["switch.a", "switch.b"]);
    const [page, board] = sockets as PageSocket[];
    expect(page!.sent.at(-1)).toEqual({ type: "state", power: "off" });
    expect(board!.sent.at(-1)).toEqual({ type: "states", states: { m1: { watching: false, power: "off" }, m2: { watching: false, power: "off" } } });
  });

  const openBoard = async (hub: ShopHub) => {
    (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
    try {
      const response = await hub.fetch(new Request("https://prism.test/api/v1/merchant/machines/ws", {
        headers: { Upgrade: "websocket", "x-prism-hub-shop": SHOP, "x-prism-hub-board": "1" },
      }));
      expect(response.status).toBe(101);
    } finally {
      delete (globalThis as any).WebSocketPair;
    }
  };
  it("gives a board the whole shop when it connects, and what Home Assistant says of the devices nothing watches", async () => {
    const { hub, sockets, connectionId, drain } = await fixture({ climate: true });
    await openBoard(hub);
    await drain();
    expect((sockets[0] as PageSocket).sent).toEqual([
      // Which devices are not live, with no values: nothing stored for them is their state.
      { type: "states", states: { m1: { watching: false }, m2: { watching: false }, m3: { watching: false } }, liveConnections: [] },
      // Then what Home Assistant said; it has no such climate entity, so the air conditioner is unknown.
      { type: "states", states: { m1: { watching: false, power: "off" }, m2: { watching: false, power: "off" }, m3: { watching: false, climate: null } } },
    ]);
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON], ["switch.b", "off", NOON, NOON]]));
    await openBoard(hub);
    await drain();
    // The climate device is on the same connection but has no stored view yet. Everything is live, so nothing is asked.
    expect((sockets[1] as PageSocket).sent).toEqual([{
      type: "states",
      states: {
        m1: { watching: true, power: "on" },
        m2: { watching: true, power: "off" },
        m3: { watching: true, climate: null },
      },
      liveConnections: [connectionId],
    }]);
  });

  it("gives a board the whole shop once a connection is live, then each change of a live device, and asks Home Assistant when it stops", async () => {
    const { hub, sockets, connectionId, drain } = await fixture();
    await openBoard(hub);
    await drain();
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    expect(board.sent).toHaveLength(2);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON], ["switch.b", "off", NOON, NOON]]));
    // Nothing is live until the connection is announced, so the first snapshot is not a change per
    // device: the board gets the whole shop, with the values, once.
    expect(board.sent.slice(2)).toEqual([
      {
        type: "states",
        states: { m1: { watching: true, power: "on" }, m2: { watching: true, power: "off" } },
        liveConnections: [connectionId],
      },
    ]);
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false));
    expect(board.sent.at(-1)).toEqual({ type: "state", power: "off", deviceId: "m1" });
    expect(board.sent).toHaveLength(4);
    // The connection stops being watched: the board is told which devices are no longer live, then what Home Assistant says of them.
    await hub.relayOffline(SHOP, "a");
    expect(board.sent.slice(4)).toEqual([
      { type: "states", states: { m1: { watching: false }, m2: { watching: false } }, liveConnections: [] },
      { type: "states", states: { m1: { watching: false, power: "off" }, m2: { watching: false, power: "off" } } },
    ]);
  });

  it("pushes and records a change once when two watchers report it at the same moment", async () => {
    const { hub, sockets, connectionId, changes } = await fixture();
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.relayOnline(SHOP, "b", "chan-b");
    const snapshot: Entry[] = [["switch.a", "on", NOON, NOON], ["switch.b", "off", NOON, NOON]];
    await hub.haReport(SHOP, "a", states(1, connectionId, snapshot));
    await hub.haReport(SHOP, "b", states(2, connectionId, snapshot));
    const sent = board.sent.length;
    const recorded = changes("power").length;
    const change: Entry[] = [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]];
    // Both are in flight together: the second must not decide before the first has been applied.
    await Promise.all([
      hub.haReport(SHOP, "a", states(1, connectionId, change, false)),
      hub.haReport(SHOP, "b", states(2, connectionId, change, false)),
    ]);
    expect(board.sent.slice(sent)).toEqual([{ type: "state", power: "off", deviceId: "m1" }]);
    expect(changes("power")).toHaveLength(recorded + 1);
  });

  it("pushes an air conditioner's full view, room temperature included, to a board once it is live", async () => {
    const { hub, sockets, connectionId } = await fixture({ climate: true });
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    const attributes = (current: number) => ({
      hvac_modes: ["off", "cool"], temperature: 24, current_temperature: current, fan_mode: "low", fan_modes: ["auto", "low"],
      min_temp: 16, max_temp: 30, target_temp_step: 1,
    });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, NOON, attributes(27)]]));
    expect(board.sent.filter((frame) => frame.type === "state")).toEqual([]);
    expect(board.sent.at(-1)).toMatchObject({ type: "states", states: { m3: { watching: true, climate: { mode: "cool", currentTemperature: 27 } } } });
    await hub.haReport(SHOP, "a", states(1, connectionId, [["climate.c", "cool", NOON, "2026-10-21T09:01:00.000Z", attributes(28)]], false));
    expect(board.sent.at(-1)).toMatchObject({ type: "state", deviceId: "m3", climate: { mode: "cool", temperature: 24, currentTemperature: 28 } });
  });

  it("never tells a board about a device that is not live", async () => {
    const { hub, sockets, sqlite, connectionId } = await fixture();
    // m2's switch is on a second Home Assistant that nothing watches; both are reported by the same IO.
    sqlite.run("UPDATE device_capabilities SET config_json=? WHERE device_id='m2'", [JSON.stringify({ connectionId: "ha_other", entityId: "switch.b" })]);
    await openBoard(hub);
    const board = sockets[0] as PageSocket;
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false));
    expect(board.sent.filter((frame) => frame.type === "state")).toEqual([{ type: "state", power: "off", deviceId: "m1" }]);
  });

  it("keeps boards, device pages and bots apart", async () => {
    const { hub, sockets, connectionId } = await fixture();
    await openBoard(hub);
    await open(hub, "m1");
    await hub.relayOnline(SHOP, "a", "chan-a");
    await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
    const [board, pageSocket] = sockets as PageSocket[];
    // A page never gets the board's frames, and a board never gets a page's greeting or watching frame.
    expect(pageSocket!.sent.every((frame) => frame.type !== "states" && frame.deviceId === undefined)).toBe(true);
    expect(board!.sent.every((frame) => frame.type === "states" || frame.type === "state")).toBe(true);
    // A board only listens: whatever it sends is not a bot request.
    await hub.webSocketMessage(board as any, JSON.stringify({ type: "request", id: "1", method: "GET", path: "integration/sessions/active" }));
    expect(board!.sent.at(-1)?.type).not.toBe("response");
  });

  describe("bots as watchers", () => {
    /** A bot connects and says hello; `ha` is whether it can watch Home Assistant. */
    const connectBot = async (hub: ShopHub, sockets: unknown[], options: { name?: string; ha?: boolean } = {}) => {
      (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
      try {
        const response = await hub.fetch(new Request("https://prism.test/api/v1/shops/code/integration/ws", {
          headers: { Upgrade: "websocket", "x-prism-hub-shop": SHOP, "x-prism-hub-shop-code": "code", authorization: "Bearer bot-token" },
        }));
        expect(response.status).toBe(101);
      } finally {
        delete (globalThis as any).WebSocketPair;
      }
      const socket = sockets.at(-1) as PageSocket;
      await hub.webSocketMessage(
        socket as any,
        JSON.stringify({ type: "hello", ...(options.ha === false ? {} : { ha: true }), name: options.name ?? "Koishi" }),
      );
      return socket;
    };
    const told = (socket: PageSocket) => socket.all.filter((frame) => frame.type === "ha.watch" || frame.type === "ha.unwatch");
    /** The bot reports the full state of `switch.a`, answering the watch it was last sent. */
    const botSnapshot = async (hub: ShopHub, socket: PageSocket, connection: string) => {
      const watch = told(socket).filter((frame) => frame.type === "ha.watch").at(-1);
      await hub.webSocketMessage(socket as any, JSON.stringify({ type: "ha", ...states(watch.watch.term, connection, [["switch.a", "on", NOON, NOON]]) }));
    };
    /** Who is watching: IOs by machine id, every bot as "bot", in a stable order. */
    const ids = async (hub: ShopHub) =>
      (await hub.watching()).map((entry) => (entry.machineId.startsWith("bot:") ? "bot" : entry.machineId)).sort();
    const stopped = (watches: Array<{ channel: string; watch: HaWatch | null }>, channel: string) =>
      watches.filter((entry) => entry.channel === channel).at(-1)?.watch === null;

    it("gives a bot a slot ahead of the IOs and sends the IO that is outranked home without a gap", async () => {
      const { hub, sockets, watches, watched, connectionId } = await fixture();
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.relayOnline(SHOP, "b", "chan-b");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
      await hub.haReport(SHOP, "b", states(2, connectionId, [["switch.a", "on", NOON, NOON]]));
      expect(await ids(hub)).toEqual(["a", "b"]);

      const bot = await connectBot(hub, sockets);
      const [watch] = told(bot);
      expect(watch.type).toBe("ha.watch");
      expect(watch.watch.connections[0].token).toBe("reader");
      // The oldest IO still holds the connection, so the newest can go at once.
      expect(stopped(watches, "chan-b")).toBe(true);
      expect(stopped(watches, "chan-a")).toBe(false);
      expect(await ids(hub)).toEqual(["a", "bot"]);
      expect(watched()).toEqual([connectionId]);
    });

    it("keeps the last IO going until the bot has delivered the state, then sends it home", async () => {
      const { hub, sockets, state, watches, watched, connectionId } = await fixture();
      state.set("limit", 1);
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));

      const bot = await connectBot(hub, sockets);
      // The bot outranks the IO but has delivered nothing: the IO carries the connection meanwhile.
      expect(await ids(hub)).toEqual(["a", "bot"]);
      expect(stopped(watches, "chan-a")).toBe(false);
      expect(watched()).toEqual([connectionId]);

      await botSnapshot(hub, bot, connectionId);
      expect(await ids(hub)).toEqual(["bot"]);
      expect(stopped(watches, "chan-a")).toBe(true);
      expect(watched()).toEqual([connectionId]);
    });

    it("does not retire cover on the strength of a held watcher's snapshot during a bot handover", async () => {
      const { hub, sockets, state, watches, watched, connectionId } = await fixture();
      state.set("limit", 1);
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.relayOnline(SHOP, "b", "chan-b");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON]]));
      await hub.poweredOff(SHOP, "a");
      await hub.haReport(SHOP, "b", states(2, connectionId, [["switch.a", "on", NOON]]));
      const bot = await connectBot(hub, sockets);
      expect(stopped(watches, "chan-b")).toBe(false);
      expect(watched()).toEqual([connectionId]);
      await botSnapshot(hub, bot, connectionId);
      expect(stopped(watches, "chan-b")).toBe(true);
      expect(await ids(hub)).toEqual(["a", "bot"]);
      expect(watched()).toEqual([connectionId]);
    });

    it("gives every slot to two bots", async () => {
      const { hub, sockets, watches, connectionId } = await fixture();
      await hub.relayOnline(SHOP, "a", "chan-a");
      await hub.relayOnline(SHOP, "b", "chan-b");
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
      await hub.haReport(SHOP, "b", states(2, connectionId, [["switch.a", "on", NOON, NOON]]));
      const first = await connectBot(hub, sockets, { name: "一号" });
      await botSnapshot(hub, first, connectionId);
      const second = await connectBot(hub, sockets, { name: "二号" });
      await botSnapshot(hub, second, connectionId);
      expect(await ids(hub)).toEqual(["bot", "bot"]);
      expect(stopped(watches, "chan-a")).toBe(true);
      expect(stopped(watches, "chan-b")).toBe(true);
    });

    it("lets an IO take the slot back when the bot leaves", async () => {
      const { hub, sockets, watches, assigned, connectionId } = await fixture();
      await hub.relayOnline(SHOP, "a", "chan-a");
      const bot = await connectBot(hub, sockets);
      await botSnapshot(hub, bot, connectionId);
      await hub.relayOnline(SHOP, "b", "chan-b");
      // A bot and the oldest IO watch; the second IO waits.
      expect(await ids(hub)).toEqual(["a", "bot"]);
      expect(assigned().some(([channel]) => channel === "chan-b")).toBe(false);

      await hub.webSocketClose(bot as any, 1006, "");
      expect(await ids(hub)).toEqual(["a", "b"]);
      expect(assigned().at(-1)![0]).toBe("chan-b");
      expect(watches.length).toBeGreaterThan(0);
    });

    it("never asks a bot that did not say it can watch", async () => {
      const { hub, sockets, connectionId } = await fixture();
      const bot = await connectBot(hub, sockets, { ha: false });
      await hub.relayOnline(SHOP, "a", "chan-a");
      expect(told(bot)).toEqual([]);
      expect(await ids(hub)).toEqual(["a"]);
      // And what it sends as a report is not believed.
      await hub.webSocketMessage(bot as any, JSON.stringify({ type: "ha", ...states(1, connectionId, [["switch.a", "off", NOON, NOON]]) }));
      expect(await ids(hub)).toEqual(["a"]);
    });

    it("stores what a bot reports the way it stores an IO's, so a shop with only a bot is live", async () => {
      const { hub, sockets, watched, power, facts, connectionId } = await fixture();
      const bot = await connectBot(hub, sockets);
      expect(watched()).toEqual([]);
      await botSnapshot(hub, bot, connectionId);
      expect(watched()).toEqual([connectionId]);
      expect(power()[0]!.value_json).toBe('"on"');
      expect(await facts("m1")).toMatchObject({ watching: true, power: "on" });
      await hub.webSocketMessage(bot as any, JSON.stringify({ type: "ha", ...states(told(bot).at(-1).watch.term, connectionId, [["switch.a", "off", "2026-10-21T09:30:00.000Z", "2026-10-21T09:30:00.000Z"]], false) }));
      expect(await facts("m1")).toMatchObject({ watching: true, power: "off" });
    });

    it("hands over to an IO that can try when the bot cannot reach Home Assistant", async () => {
      const { hub, sockets, state, watches, connectionId } = await fixture();
      state.set("limit", 1);
      await hub.relayOnline(SHOP, "a", "chan-a");
      const bot = await connectBot(hub, sockets);
      expect(await ids(hub)).toEqual(["bot"]);
      const term = told(bot).at(-1).watch.term;
      await hub.webSocketMessage(bot as any, JSON.stringify({ type: "ha", ...status(term, connectionId, false) }));
      // The bot ranks behind a healthy IO for a while, so the IO takes the only slot.
      expect(await ids(hub)).toEqual(["a"]);
      expect(told(bot).at(-1).type).toBe("ha.unwatch");
      expect(watches.some((entry) => entry.channel === "chan-a" && entry.watch)).toBe(true);
    });

    it("forgets a bot that vanished without closing, at once and not after its lease", async () => {
      const { hub, sockets, connectionId } = await fixture();
      await hub.relayOnline(SHOP, "a", "chan-a");
      const bot = await connectBot(hub, sockets);
      await botSnapshot(hub, bot, connectionId);
      expect(await ids(hub)).toEqual(["a", "bot"]);
      // A deploy drops the connection and no close arrives.
      sockets.splice(sockets.indexOf(bot), 1);
      await hub.alarm();
      expect(await ids(hub)).toEqual(["a"]);
    });

    it("follows the shop's number of watchers when the administrator changes it", async () => {
      const { hub, sqlite, watches, connectionId } = await fixture();
      for (const [machine, channel] of [["a", "chan-a"], ["b", "chan-b"], ["c", "chan-c"]] as const) await hub.relayOnline(SHOP, machine, channel);
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
      await hub.haReport(SHOP, "b", states(2, connectionId, [["switch.a", "on", NOON, NOON]]));
      expect(await ids(hub)).toEqual(["a", "b"]);

      const setLimit = (count: number) => sqlite.run(
        `INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,?,?,'2026-01-01')
         ON CONFLICT(shop_id,key) DO UPDATE SET value_json=excluded.value_json`,
        [SHOP, "devices.ha_watcher_limit", JSON.stringify({ count })],
      );
      setLimit(1);
      await hub.refresh(SHOP);
      expect(await ids(hub)).toEqual(["a"]);
      expect(stopped(watches, "chan-b")).toBe(true);

      setLimit(3);
      await hub.refresh(SHOP);
      expect(await ids(hub)).toEqual(["a", "b", "c"]);
      // A value out of range is not believed.
      setLimit(9);
      await hub.refresh(SHOP);
      expect(await ids(hub)).toEqual(["a", "b"]);
    });

    it("tells a board who is watching, as it changes", async () => {
      const { hub, sockets, connectionId } = await fixture();
      await openBoard(hub);
      const board = sockets[0] as PageSocket;
      expect(board.watchers).toEqual([{ type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 }]);

      await hub.relayOnline(SHOP, "a", "chan-a");
      expect(board.watchers.at(-1)).toEqual({ type: "watchers", limit: 2, max: 4, standby: 0, watchers: [{ id: "a", kind: "device", deviceId: "a", state: "starting" }] });
      await hub.haReport(SHOP, "a", states(1, connectionId, [["switch.a", "on", NOON, NOON]]));
      expect(board.watchers.at(-1)!.watchers[0].state).toBe("watching");

      const bot = await connectBot(hub, sockets, { name: "前台 Bot" });
      const latest = board.watchers.at(-1)!;
      // A bot is listed first, by the name it gave.
      expect(latest.watchers.map((watcher: any) => [watcher.kind, watcher.name ?? watcher.deviceId, watcher.state])).toEqual([
        ["bot", "前台 Bot", "starting"],
        ["device", "a", "watching"],
      ]);
      await botSnapshot(hub, bot, connectionId);
      expect(board.watchers.at(-1)!.watchers[0].state).toBe("watching");
      // Nothing changed: the board is not told again.
      const count = board.watchers.length;
      await hub.haReport(SHOP, "a", status(1, connectionId, true));
      expect(board.watchers.length).toBe(count);
    });
  });

  it("needs the shop that the route names", async () => {
    const { hub } = await fixture();
    (globalThis as any).WebSocketPair = class { 0 = new PageSocket(); 1 = new PageSocket(); };
    try {
      const response = await hub.fetch(new Request("https://prism.test/x", { headers: { Upgrade: "websocket", "x-prism-hub-board": "1" } }));
      expect(response.status).toBe(400);
    } finally {
      delete (globalThis as any).WebSocketPair;
    }
  });
});
