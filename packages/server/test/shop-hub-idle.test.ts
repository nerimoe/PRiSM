import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { newHaConnection, writeHaConnection } from "../src/resources/capabilities/ha-connections.js";
import { IDLE_SETTINGS_KEY } from "../src/resources/capabilities/idle-power.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";
import { createOccupancy } from "../src/resources/occupancy/service.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const KEY = "idle-test-key";
const MIN = 60_000;

/** `watched`: the hub has announced the machine's Home Assistant connection, so its stored power is a fact. */
async function fixture(settings: unknown, options: { watched?: boolean; climate?: boolean } = {}) {
  const { watched = true } = options;
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  // Players and users are beside the point here.
  sqlite.run("PRAGMA foreign_keys=OFF");
  const db = createD1DatabaseFromSqlite(sqlite);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','A',0,0,80,'u')");
  const connection = await newHaConnection("https://ha.example", "control", KEY);
  await writeHaConnection(db, "shop", connection).run();
  // Only occupancy keeps it busy; power operations reset the shutdown wait.
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,occupancy_minutes) VALUES ('m1','p1','shop','舞萌','',30)");
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES ('shop','m1','power',?,'{}','2026-01-01','2026-01-01')`,
    [JSON.stringify({ connectionId: connection.id, entityId: "switch.m1" })],
  );
  const onSince = new Date(Date.now() - 40 * MIN).toISOString();
  sqlite.run(
    `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
     VALUES ('shop','m1','power','power','"on"','observed',?)`,
    [onSince],
  );
  if (options.climate) {
    sqlite.run("UPDATE device_capabilities SET capability='climate',config_json=? WHERE device_id='m1'", [JSON.stringify({ connectionId: connection.id, entityId: "climate.m1" })]);
    sqlite.run("DELETE FROM device_state WHERE device_id='m1'");
    for (const key of ["view", "climate"]) sqlite.run(
      `INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at)
       VALUES ('shop','m1','climate',?,?,'observed',?)`,
      [key, JSON.stringify({ mode: "cool", temperature: 24, currentTemperature: 27, fanMode: "auto" }), onSince],
    );
  }
  sqlite.run("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('shop',?,?,?)", [IDLE_SETTINGS_KEY, JSON.stringify(settings), onSince]);
  const state = new Map<string, unknown>();
  if (watched) {
    // A live watcher that has delivered the connection's full state, as the hub itself would leave it.
    state.set("eventConnections", [connection.id]);
    state.set("watchers", {
      a: { machineId: "a", channel: "chan-a", term: 1, leaseUntil: Date.now() + 10 * MIN, links: { [connection.id]: { connected: true, snapshot: true } } },
    });
  }
  const sockets: Array<{ tags: string[]; send(data: string): void; deserializeAttachment(): unknown }> = [];
  let alarm: number | null = null;
  const ctx = {
    storage: {
      async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { state.set(key, structuredClone(value)); },
      async delete(key: string) { return state.delete(key); },
      async getAlarm() { return alarm; },
      async setAlarm(at: number) { alarm = at; },
      async deleteAlarm() { alarm = null; },
    },
    getWebSockets(tag?: string) { return tag ? sockets.filter((socket) => socket.tags.includes(tag)) : sockets; },
  };
  const hub = new ShopHub(ctx as any, { DB: db, URL_ENCRYPTION_KEY: KEY } as any);
  const fireAlarm = async () => {
    alarm = null;
    await hub.alarm();
  };
  const run = async () => {
    await hub.touch("shop");
    state.set("touchAt", Date.now() - 1);
    await fireAlarm();
  };
  const offs = () =>
    sqlite.query<{ action: string; player_id: string | null; staff_id: string | null }, []>(
      "SELECT action, player_id, staff_id FROM device_operations WHERE action IN ('power.off','climate.off')",
    ).all();
  return { hub, db, sqlite, run, fireAlarm, sockets, offs, state, connectionId: connection.id, alarm: () => alarm };
}

const haCalls = () => spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/services/switch/turn_off" || path === "/api/services/climate/turn_off") return new Response("[]", { status: 200 });
  if (path === "/api/states/switch.m1") return Response.json({ state: "off" });
  if (path === "/api/states/climate.m1") return Response.json({ state: "off", attributes: {} });
  return new Response("", { status: 404 });
}) as typeof fetch);

describe("idle check in the shop hub", () => {
  it("counts down from occupancy expiry, extends it for an eligible card, and rejects an unbilled renewal", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { db, sqlite, run, fireAlarm, offs, state, sockets, alarm } = await fixture({ device: { enabled: true, minutes: 10, whileOccupied: "off" } });
    const watchers = state.get("watchers") as any;
    watchers.a.leaseUntil = start + 60 * MIN;
    state.set("watchers", watchers);
    sqlite.run("UPDATE machines SET capacity=1,occupancy_minutes=2,pricing_config_override_id='arcade' WHERE id='m1'");
    sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
      VALUES ('shop','m1','hinata_io','{}','{}','2026-01-01','2026-01-01')`);
    sqlite.run(`INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json)
      VALUES ('shop','s1','p','2026-01-01','active','["arcade"]'),('shop','s2','other','2026-01-01','active','["other"]')`);
    const notices: any[] = [];
    sockets.push({ tags: ["bot"], deserializeAttachment: () => ({ kind: "bot", reminderLeadMs: 5 * MIN }), send: (data) => notices.push(JSON.parse(data)) });
    const occupancy = createOccupancy({ db, shopId: "shop", now: () => new Date(now) });
    const scan = () => occupancy.observe({ resourceId: "m1", event: { kind: "signal", name: "card.consumed", payload: {}, playerId: "p" } });
    const spy = haCalls();
    try {
      await scan();
      await run();
      expect(alarm()).toBe(start + 2 * MIN);
      expect((state.get("idle") as any).powerOffAt).toEqual({});
      now = start + 2 * MIN;
      await fireAlarm();
      expect((await occupancy.current())[0]!.occupants).toEqual([]);
      expect((state.get("idle") as any).powerOffAt).toEqual({ m1: start + 12 * MIN });
      expect(offs()).toEqual([]);
      now = start + 7 * MIN;
      await fireAlarm();
      expect(notices.at(-1).data.at).toBe(start + 12 * MIN);
      now = start + 8 * MIN;
      await scan();
      await run();
      expect((await occupancy.current())[0]!.occupants).toHaveLength(1);
      expect((state.get("idle") as any).powerOffAt).toEqual({});
      now = start + 10 * MIN;
      await fireAlarm();
      expect((state.get("idle") as any).powerOffAt).toEqual({ m1: start + 20 * MIN });
      sqlite.run("UPDATE sessions SET status='closed' WHERE id='s1'");
      now = start + 12 * MIN;
      await scan();
      await run();
      expect((await occupancy.current())[0]!.occupants).toEqual([]);
      expect((state.get("idle") as any).powerOffAt).toEqual({ m1: start + 20 * MIN });
      expect(offs()).toEqual([]);
      now = start + 20 * MIN;
      await fireAlarm();
      expect(offs()).toHaveLength(1);
      expect(sqlite.query("SELECT * FROM device_state WHERE key='idle'").all()).toEqual([]);
      expect(sqlite.query("SELECT * FROM device_events WHERE kind='change' AND name='idle'").all()).toEqual([]);
    } finally { spy.mockRestore(); clock.mockRestore(); sqlite.close(); }
  });

  for (const scenario of [
    { policy: "off", players: 1, sendFails: false, climate: false, shared: false, lead: 2 },
    { policy: "remind", players: 1, sendFails: false },
    { policy: "off", players: 0, sendFails: false },
    { policy: "off", players: 1, sendFails: true },
    { policy: "off", players: 1, sendFails: false, climate: false, shared: true },
    { policy: "off", players: 1, sendFails: false, climate: true, shared: false },
    { policy: "off", players: 0, sendFails: false, climate: true, shared: true },
  ]) it(`warns at the configured lead time and still switches off: ${JSON.stringify(scenario)}`, async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { sqlite, run, fireAlarm, offs, sockets, state, alarm } = await fixture({
      device: { enabled: true, minutes: 10, whileOccupied: scenario.policy },
    }, { climate: scenario.climate });
    const lead = scenario.lead ?? 5;
    const notices: any[] = [];
    sockets.push({
      tags: ["bot"],
      deserializeAttachment: () => ({ kind: "bot", reminderLeadMs: lead * MIN }),
      send(data: string) {
        notices.push(JSON.parse(data));
        if (scenario.sendFails) throw new Error("Bot disconnected");
      },
    });
    // Isolate the idle alarm from watcher lease renewals.
    const watchers = state.get("watchers") as Record<string, { leaseUntil: number }>;
    watchers.a!.leaseUntil = start + 60 * MIN;
    state.set("watchers", watchers);
    sqlite.run("UPDATE machines SET occupancy_minutes=1 WHERE id='m1'");
    sqlite.run("UPDATE device_state SET changed_at=? WHERE key IN ('power','climate')", [new Date(start).toISOString()]);
    if (scenario.shared) {
      sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,occupancy_minutes) VALUES ('m2','p2','shop','中二','',1)");
      sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) SELECT shop_id,'m2',capability,config_json,secret_json,created_at,updated_at FROM device_capabilities WHERE device_id='m1'`);
      sqlite.run(`INSERT INTO device_state SELECT shop_id,'m2',capability,key,value_json,authority,event_id,changed_at FROM device_state WHERE device_id='m1'`);
    }
    if (scenario.players) sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    if (scenario.climate && scenario.players) {
      sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,occupancy_minutes) VALUES ('game','game','shop','机台','',1)");
      sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) VALUES ('shop','game','hinata_io','{}','{}','2026-01-01','2026-01-01')`);
      sqlite.run(`INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,player_id,payload_json,occurred_at) VALUES ('shop','game-use','game','hinata_io','request','coin','platform','p','{}',?)`, [new Date(start).toISOString()]);
    }
    const spy = haCalls();
    try {
      await run();
      expect(alarm()).toBe(start + (10 - lead) * MIN);
      expect(offs()).toEqual([]);
      expect(notices).toEqual([]);
      now = start + (10 - lead) * MIN;
      // Ambient changes refresh the view, but must not postpone the shutdown.
      if (scenario.climate) sqlite.run("UPDATE device_state SET changed_at=?, value_json=? WHERE key='view'", [new Date(now).toISOString(), JSON.stringify({ mode: "cool", temperature: 24, currentTemperature: 28 })]);
      await fireAlarm();
      expect(notices).toEqual([{
        type: "event", event: "idle.reminder",
        data: { reason: "device_idle", at: start + 10 * MIN, devices: [{ id: "m1", name: "舞萌" }, ...(scenario.shared ? [{ id: "m2", name: "中二" }] : [])] },
      }]);
      expect(offs()).toEqual([]);
      expect(alarm()).toBe(start + 10 * MIN);
      // Once warned, no Bot and no user action is needed to keep the deadline.
      sockets.length = 0;
      now = start + 10 * MIN;
      await fireAlarm();
      expect(offs()).toEqual([{ action: scenario.climate ? "climate.off" : "power.off", player_id: null, staff_id: null }]);
      expect(spy.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith("/api/services/"))).toHaveLength(1);
      const memory = state.get("idle") as { lastAutoOff: Record<string, number> };
      for (const id of scenario.shared ? ["m1", "m2"] : ["m1"]) expect(memory.lastAutoOff[`${scenario.climate ? "climate:" : ""}${id}`]).toBe(now);
    } finally { spy.mockRestore(); clock.mockRestore(); sqlite.close(); }
  });

  for (const climate of [false, true]) it(`a sibling's recent use protects a shared actuator, climate=${climate}`, async () => {
    const start = Date.now();
    const { sqlite, run, offs, state } = await fixture({ device: { enabled: true, minutes: 10, whileOccupied: "off" } }, { climate });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,occupancy_minutes) VALUES ('m2','p2','shop','中二','',1)");
    sqlite.run("UPDATE machines SET occupancy_minutes=1 WHERE id='m1'");
    sqlite.run("INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) SELECT shop_id,'m2',capability,config_json,secret_json,created_at,updated_at FROM device_capabilities WHERE device_id='m1'");
    sqlite.run("INSERT INTO device_state SELECT shop_id,'m2',capability,key,value_json,authority,event_id,changed_at FROM device_state WHERE device_id='m1'");
    if (climate) sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) VALUES ('shop','m2','hinata_io','{}','{}','2026-01-01','2026-01-01')`);
    sqlite.run(`INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,player_id,payload_json,occurred_at)
      VALUES ('shop','e1','m2',?,'request',?,'platform','p','{}',?)`,
      [climate ? "hinata_io" : "power", climate ? "coin" : "power.keep", new Date(start).toISOString()]);
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([]);
      expect((state.get("idle") as any).powerOffAt).toEqual({ m1: start + 10 * MIN, m2: start + 10 * MIN });
      sqlite.run("UPDATE app_settings SET value_json=? WHERE key=?", [JSON.stringify({ device: { enabled: true, whileOccupied: "off" }, devices: { m2: { exclude: true } } }), IDLE_SETTINGS_KEY]);
      await run();
      expect(offs()).toEqual([]);
      expect((state.get("idle") as any).powerOffAt).toEqual({});
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("retries a failed empty-shop climate shutdown without completing the empty period", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { sqlite, run, offs, state } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } }, { climate: true });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z',?,'closed')", [new Date(start - 20 * MIN).toISOString()]);
    const watchers = state.get("watchers") as any;
    watchers.a.leaseUntil = start + 60 * MIN;
    state.set("watchers", watchers);
    let fail = true;
    const spy = spyOn(globalThis, "fetch").mockImplementation((async (_url: string | URL | Request) => new Response(fail ? "failed" : "[]", { status: fail ? 503 : 200 })) as typeof fetch);
    try {
      await run();
      expect(offs()).toHaveLength(1);
      expect((state.get("idle") as any).emptyHandled).toBeNull();
      now = start + MIN;
      await run();
      expect(offs()).toHaveLength(1);
      fail = false;
      now = start + 10 * MIN;
      await run();
      expect(offs()).toHaveLength(2);
      expect((state.get("idle") as any).emptyHandled).toBe(start - 20 * MIN);
    } finally { spy.mockRestore(); clock.mockRestore(); sqlite.close(); }
  });

  for (const powered of [false, true]) it(`keeps climate on for another cabinet and cancels an old warning after renewed use, power binding=${powered}`, async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { sqlite, run, offs, state, sockets, connectionId } = await fixture({ device: { enabled: true, minutes: 10, whileOccupied: "off" } }, { climate: true });
    const notices: any[] = [];
    sockets.push({ tags: ["bot"], deserializeAttachment: () => ({ kind: "bot", reminderLeadMs: 5 * MIN }), send: (data) => notices.push(JSON.parse(data)) });
    const watchers = state.get("watchers") as any;
    watchers.a.leaseUntil = start + 60 * MIN;
    state.set("watchers", watchers);
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,capacity,occupancy_minutes) VALUES ('m2','p2','shop','舞萌','',1,1)");
    sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) VALUES ('shop','m2','hinata_io','{}','{}','2026-01-01','2026-01-01')`);
    if (powered) {
      sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) VALUES ('shop','m2','power',?,'{}','2026-01-01','2026-01-01')`, [JSON.stringify({ connectionId, entityId: "switch.m2" })]);
      sqlite.run(`INSERT INTO device_state(shop_id,device_id,capability,key,value_json,authority,changed_at) VALUES ('shop','m2','power','power','"on"','observed',?)`, [new Date(start - 40 * MIN).toISOString()]);
    }
    sqlite.run(`INSERT INTO resource_occupancies(shop_id,id,resource_id,player_id,source,started_at,last_seen_at,expires_at)
      VALUES ('shop','o1','m2','p','hinata_io',?,?,?)`, [new Date(start).toISOString(), new Date(start).toISOString(), new Date(start + MIN).toISOString()]);
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([]);
      expect((state.get("idle") as any).powerOffAt.m1).toBe(start + 11 * MIN);
      now = start + 6 * MIN;
      await run();
      expect(notices.some((frame) => frame.data?.devices.some((device: any) => device.id === "m1"))).toBe(true);
      expect(offs()).toEqual([]);
      // A fresh cabinet action postpones climate too, after the old warning was sent.
      sqlite.run(`INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,player_id,payload_json,occurred_at)
        VALUES ('shop','e1','m2','hinata_io','request','coin','platform','p','{}',?)`, [new Date(now).toISOString()]);
      sqlite.run(`INSERT INTO resource_occupancies(shop_id,id,resource_id,player_id,source,started_at,last_seen_at,expires_at)
        VALUES ('shop','o2','m2','p','hinata_io',?,?,?)`, [new Date(now).toISOString(), new Date(now).toISOString(), new Date(now + MIN).toISOString()]);
      await run();
      expect((state.get("idle") as any).powerOffAt.m1).toBe(start + 17 * MIN);
      now = start + 11 * MIN;
      // Even a fresh AC setting must not create its own idle timer.
      sqlite.run("UPDATE device_state SET changed_at=?,value_json=? WHERE device_id='m1' AND capability='climate'", [new Date(now).toISOString(), JSON.stringify({ mode: "heat", temperature: 25 })]);
      sqlite.run(`INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,player_id,payload_json,occurred_at) VALUES ('shop','ac-setting','m1','climate','request','climate.set_temperature','platform','p','{}',?)`, [new Date(now).toISOString()]);
      await run();
      expect(offs()).toEqual([]);
      now = start + 17 * MIN;
      await run();
      expect(offs().filter((operation) => operation.action === "climate.off")).toHaveLength(1);
    } finally { spy.mockRestore(); clock.mockRestore(); sqlite.close(); }
  });

  it("switches an empty shop's machines off as the system once its time is up", async () => {
    const { hub, run, offs, sqlite } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } });
    const announced = spyOn(hub, "shopEvent");
    sqlite.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z',?,'closed')",
      [new Date(Date.now() - 20 * MIN).toISOString()],
    );
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([{ action: "power.off", player_id: null, staff_id: null }]);
      expect(spy.mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain("/api/services/switch/turn_off");
      // The same empty period does not switch it off twice.
      await run();
      expect(offs()).toHaveLength(1);
      expect(announced).not.toHaveBeenCalled();
    } finally { announced.mockRestore(); spy.mockRestore(); sqlite.close(); }
  });



  it("can keep an unoccupied machine on without writing an idle flag", async () => {
    const { run, offs, sqlite, state } = await fixture({ shopEmpty: { enabled: true, minutes: 15 }, device: { enabled: true, whileOccupied: "mark" } });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([]);
      expect(sqlite.query("SELECT * FROM device_state WHERE key='idle'").all()).toEqual([]);
      // Someone occupying the machine: the power decision still follows occupancy.
      sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
        VALUES ('shop','m1','hinata_io','{}','{}','2026-01-01','2026-01-01')`);
      sqlite.run("UPDATE machines SET capacity=1 WHERE id='m1'");
      const seen = new Date();
      sqlite.run(
        `INSERT INTO resource_occupancies(shop_id,id,resource_id,player_id,source,started_at,last_seen_at,expires_at)
         VALUES ('shop','o1','m1','p','hinata_io',?,?,?)`,
        [seen.toISOString(), seen.toISOString(), new Date(seen.getTime() + 30 * MIN).toISOString()],
      );
      await run();
      expect(sqlite.query("SELECT * FROM device_state WHERE key='idle'").all()).toEqual([]);
      expect(offs()).toEqual([]);
      expect((state.get("idle") as { powerOffAt: unknown }).powerOffAt).toEqual({});
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("does not count its own power-off as activity", async () => {
    const { run, sqlite } = await fixture({ device: { enabled: true, whileOccupied: "off" } });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    const spy = haCalls();
    try {
      await run();
      const events = sqlite.query("SELECT kind, name FROM device_events WHERE device_id='m1' AND kind='request'").all();
      expect(events).toEqual([{ kind: "request", name: "power.off" }]);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("does not switch off a machine the stored state says is already off", async () => {
    const { run, offs, sqlite } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } });
    sqlite.run("UPDATE device_state SET value_json='\"off\"' WHERE key='power'");
    sqlite.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z',?,'closed')",
      [new Date(Date.now() - 20 * MIN).toISOString()],
    );
    const spy = haCalls();
    try {
      await run();
      expect(offs()).toEqual([]);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("switches an empty shop's machines off even when nothing watches them", async () => {
    const { run, offs, sqlite } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } }, { watched: false });
    sqlite.run("UPDATE device_state SET value_json='\"off\"' WHERE key='power'");
    sqlite.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z',?,'closed')",
      [new Date(Date.now() - 20 * MIN).toISOString()],
    );
    const spy = haCalls();
    try {
      // The stored "off" is stale without a watcher and is not believed.
      await run();
      expect(offs()).toHaveLength(1);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("switches a machine of unknown state off once, from its own last activity", async () => {
    const { run, offs, sqlite } = await fixture({ device: { enabled: true, whileOccupied: "off" } }, { watched: false });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    const spy = haCalls();
    try {
      // Nothing is known about it and nobody has touched it: there is no clock to judge by.
      await run();
      expect(offs()).toEqual([]);
      // A player switched it on through the platform 40 minutes ago.
      sqlite.run(
        `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,player_id,payload_json,occurred_at)
         VALUES ('shop','e1','m1','power','request','power.on','platform','p','{}',?)`,
        [new Date(Date.now() - 40 * MIN).toISOString()],
      );
      await run();
      expect(offs()).toHaveLength(1);
      // Nothing shows whether it took, so the same idleness does not switch it off again.
      await run();
      expect(offs()).toHaveLength(1);
    } finally { spy.mockRestore(); sqlite.close(); }
  });

  it("uses the idle wait without adding an occupancy period to a power operation, with or without seats", async () => {
    const { run, offs, sqlite } = await fixture({ device: { enabled: true, minutes: 10, whileOccupied: "off" } }, { watched: false });
    sqlite.run("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES ('shop','s1','p','2026-01-01T00:00:00Z','active')");
    sqlite.run(
      `INSERT INTO device_events(shop_id,id,device_id,capability,kind,name,origin,player_id,payload_json,occurred_at)
       VALUES ('shop','e1','m1','power','request','power.on','platform','p','{}',?)`,
      [new Date(Date.now() - 20 * MIN).toISOString()],
    );
    const spy = haCalls();
    try {
      // Switched on 20 minutes ago with no occupant: the 10 minute wait has elapsed.
      await run();
      expect(offs()).toHaveLength(1);
      // Adding seats must not change the deadline or duplicate a completed shutdown.
      sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
        VALUES ('shop','m1','mahjong','{"pricingConfigIds":[]}','{}','2026-01-01','2026-01-01')`);
      sqlite.run("UPDATE machines SET capacity=4 WHERE id='m1'");
      await run();
      expect(offs()).toHaveLength(1);
    } finally { spy.mockRestore(); sqlite.close(); }
  });
});
