import { describe, expect, it, spyOn } from "bun:test";
import { groupsOf } from "./announce-groups.js";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { newHaConnection, writeHaConnection } from "../src/resources/capabilities/ha-connections.js";
import { IDLE_SETTINGS_KEY, RETRY_OFF_MS, type IdleSignal, type IdleTimers } from "../src/resources/capabilities/idle-power.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const KEY = "idle-test-key";
const MIN = 60_000;

/** `watched`: the hub has announced the machine's Home Assistant connection, so its stored power is a fact. */
async function fixture(settings: unknown, options: { watched?: boolean; climate?: boolean; onForMinutes?: number } = {}) {
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
  const onSince = new Date(Date.now() - (options.onForMinutes ?? 40) * MIN).toISOString();
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
      a: { machineId: "a", channel: "chan-a", term: 1, leaseUntil: Date.now() + 600 * MIN, links: { [connection.id]: { connected: true, snapshot: true } } },
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
  /** Tell the hub's idle timers what happened, as the event subscriber and the routes do. */
  const tell = (...signals: IdleSignal[]) => hub.idleEvents("shop", signals);
  const offs = () =>
    sqlite.query<{ action: string; player_id: string | null; staff_id: string | null }, []>(
      "SELECT action, player_id, staff_id FROM device_operations WHERE action IN ('power.off','climate.off')",
    ).all();
  return { hub, db, sqlite, tell, fireAlarm, sockets, offs, state, connectionId: connection.id, alarm: () => alarm };
}

const haCalls = () => spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path === "/api/services/switch/turn_off" || path === "/api/services/climate/turn_off") return new Response("[]", { status: 200 });
  if (path === "/api/states/switch.m1") return Response.json({ state: "off" });
  if (path === "/api/states/climate.m1") return Response.json({ state: "off", attributes: {} });
  return new Response("", { status: 404 });
}) as typeof fetch);

/**
 * A bot whose rules say the idle warning in one group, connected to the hub.
 * `notices` is what the hub decided to warn about; `said` is what the bot was
 * told to say, and where.
 */
function listening(hub: unknown, sockets: unknown[], lead: number, fails = false) {
  const notices: Array<{ data: any }> = [];
  const said: any[] = [];
  const target = hub as { notify(list: unknown[]): Promise<void>; botOf(): Promise<unknown> };
  const notify = target.notify.bind(target);
  target.notify = async (list) => {
    notices.push(...list.map((data) => ({ data })));
    return notify(list);
  };
  target.botOf = async () => ({
    bot: {
      id: "bot", name: "Bot", enabled: true,
      config: { announceGroups: groupsOf([{ events: ["idle.reminder"], sources: [], to: ["onebot:1"] }]), replyTemplates: {}, idleReminderMinutes: lead },
    },
    view: { staff: [] },
  });
  sockets.push({
    tags: ["bot"],
    deserializeAttachment: () => ({ kind: "bot", token: "t", shopCode: "shop-code", commands: true, reminderLeadMs: lead * MIN }),
    send(data: string) {
      said.push(JSON.parse(data));
      if (fails) throw new Error("Bot disconnected");
    },
  });
  return { notices, said };
}

const deviceRule = (whileOccupied: "off" | "mark" = "off") => ({ device: { enabled: true, minutes: 10, whileOccupied } });
const timersOf = (state: Map<string, unknown>) => state.get("idle") as IdleTimers;
const openBill = (sqlite: Database) => sqlite.run(
  `INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json) VALUES ('shop','s1','p','2026-01-01','active','["arcade"]')`,
);

describe("idle timers in the shop hub", () => {
  it("starts a device's timer when it is switched on, warns through the bot, then switches it off as the system", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, tell, fireAlarm, offs, state, sockets, alarm } = await fixture(deviceRule(), { onForMinutes: 0 });
    const { notices, said } = listening(hub, sockets, 3);
    const spy = haCalls();
    try {
      await tell({ kind: "on", deviceId: "m1" });
      // The alarm is for the warning, a lead ahead of the power-off.
      expect(alarm()).toBe(start + 7 * MIN);
      expect(await hub.idleSchedule()).toEqual({ m1: start + 10 * MIN });
      now = start + 7 * MIN;
      await fireAlarm();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.data).toMatchObject({ reason: "device_idle", at: start + 10 * MIN, devices: [{ id: "m1", name: "舞萌" }] });
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ type: "say", to: "onebot:1" });
      expect(offs()).toEqual([]);
      expect(alarm()).toBe(start + 10 * MIN);
      now = start + 10 * MIN;
      await fireAlarm();
      expect(offs()).toEqual([{ action: "power.off", player_id: null, staff_id: null }]);
      // Said once, and nothing more is warned about.
      expect(notices).toHaveLength(1);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("starts the timer again at a coin, and from the end of a stay at an authorised card", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, sqlite, tell, fireAlarm, offs, alarm } = await fixture(deviceRule(), { onForMinutes: 0 });
    const spy = haCalls();
    try {
      openBill(sqlite);
      await tell({ kind: "on", deviceId: "m1" });
      expect(alarm()).toBe(start + 10 * MIN);
      now = start + 6 * MIN;
      await tell({ kind: "activity", deviceId: "m1" });
      // An alarm already set earlier is left to fire and find nothing due.
      expect(await hub.idleSchedule()).toEqual({ m1: start + 16 * MIN });
      now = start + 10 * MIN;
      await fireAlarm();
      expect(offs()).toEqual([]);
      // The machine counts a player as on it for 30 minutes after their card.
      now = start + 12 * MIN;
      await tell({ kind: "activity", deviceId: "m1", stay: true });
      expect(await hub.idleSchedule()).toEqual({ m1: start + 52 * MIN });
      now = start + 52 * MIN;
      await fireAlarm();
      expect(offs()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("holds a kept device on for the shop's keep time, however short its idle time", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, sqlite, tell, fireAlarm, offs } = await fixture({ ...deviceRule(), keepMinutes: 30 }, { onForMinutes: 0 });
    const spy = haCalls();
    try {
      openBill(sqlite);
      await tell({ kind: "on", deviceId: "m1" });
      now = start + 5 * MIN;
      await tell({ kind: "keep", deviceId: "m1" });
      expect(await hub.idleSchedule()).toEqual({ m1: start + 35 * MIN });
      now = start + 20 * MIN;
      await fireAlarm();
      expect(offs()).toEqual([]);
      now = start + 35 * MIN;
      await fireAlarm();
      expect(offs()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("ends the timer when the device is switched off", async () => {
    const { tell, state, alarm } = await fixture(deviceRule(), { onForMinutes: 0 });
    await tell({ kind: "on", deviceId: "m1" });
    expect(Object.keys(timersOf(state).entries)).toHaveLength(1);
    await tell({ kind: "off", deviceId: "m1" });
    expect(timersOf(state).entries).toEqual({});
    expect(timersOf(state).wakeAt).toBeNull();
    // The watcher's lease is all the alarm is still needed for.
    expect(alarm()).toBeGreaterThan(Date.now() + MIN);
  });

  it("takes stock once when it has no timers: a machine reported on for longer than the idle time is switched off", async () => {
    const { tell, offs, state } = await fixture(deviceRule());
    const spy = haCalls();
    try {
      // Nothing happened to the machine; the hub is only asked to set its alarm.
      await tell();
      expect(offs()).toEqual([{ action: "power.off", player_id: null, staff_id: null }]);
      // Home Assistant reports this one: its `off` ends the timer.
      expect(Object.values(timersOf(state).entries)[0]).toMatchObject({ seen: true, sent: 1 });
      await tell({ kind: "off", deviceId: "m1" });
      expect(timersOf(state).entries).toEqual({});
    } finally {
      spy.mockRestore();
    }
  });

  it("only marks a device that runs out while players are in, and switches it off once the shop is empty", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, sqlite, tell, fireAlarm, offs, state } = await fixture(deviceRule("mark"), { onForMinutes: 0 });
    const spy = haCalls();
    try {
      openBill(sqlite);
      await tell({ kind: "on", deviceId: "m1" });
      expect(await hub.idleSchedule()).toEqual({});
      now = start + 10 * MIN;
      await fireAlarm();
      expect(offs()).toEqual([]);
      expect(Object.values(timersOf(state).entries)[0]!.marked).toBe(true);
      sqlite.run("UPDATE sessions SET status='closed' WHERE id='s1'");
      now = start + 30 * MIN;
      await tell({ kind: "sessions" });
      expect(offs()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("starts the shop-empty timer when the last bill closes, and switches everything off with the air conditioner", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, sqlite, tell, fireAlarm, offs, alarm, sockets, connectionId } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } }, { onForMinutes: 0 });
    sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('ac','p2','shop','空调','')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop','ac','climate',?,'{}','2026-01-01','2026-01-01')`,
      [JSON.stringify({ connectionId, entityId: "climate.m1" })],
    );
    const { notices } = listening(hub, sockets, 5);
    const spy = haCalls();
    try {
      openBill(sqlite);
      await tell({ kind: "on", deviceId: "m1" });
      // With players in and only the shop rule on, nothing times the machine.
      expect(await hub.idleSchedule()).toEqual({});
      sqlite.run("UPDATE sessions SET status='closed' WHERE id='s1'");
      now = start + MIN;
      await tell({ kind: "sessions" });
      expect(await hub.idleSchedule()).toEqual({ m1: start + 16 * MIN });
      expect(alarm()).toBe(start + 11 * MIN);
      now = start + 11 * MIN;
      await fireAlarm();
      expect(notices.map((notice) => notice.data.reason)).toEqual(["shop_empty"]);
      expect(offs()).toEqual([]);
      now = start + 16 * MIN;
      await fireAlarm();
      expect(offs().map((off) => off.action).sort()).toEqual(["climate.off", "power.off"]);
      // Someone entering before that would have called it off.
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("calls the shop-empty timer off when someone enters", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, sqlite, tell, fireAlarm, offs } = await fixture({ shopEmpty: { enabled: true, minutes: 15 } }, { onForMinutes: 0 });
    const spy = haCalls();
    try {
      await tell({ kind: "on", deviceId: "m1" });
      expect(await hub.idleSchedule()).toEqual({ m1: start + 15 * MIN });
      openBill(sqlite);
      now = start + 5 * MIN;
      await tell({ kind: "sessions" });
      expect(await hub.idleSchedule()).toEqual({});
      now = start + 60 * MIN;
      await fireAlarm();
      expect(offs()).toEqual([]);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("sends a failed power-off again later", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { tell, fireAlarm, offs, alarm, sqlite } = await fixture(deviceRule(), { onForMinutes: 0 });
    let fail = true;
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response(fail ? "" : "[]", { status: fail ? 500 : 200 })) as unknown as typeof fetch);
    try {
      await tell({ kind: "on", deviceId: "m1" });
      now = start + 10 * MIN;
      await fireAlarm();
      expect(sqlite.query("SELECT status FROM device_operations WHERE action='power.off'").all()).toEqual([{ status: "failed" }]);
      expect(alarm()).toBe(now + RETRY_OFF_MS);
      fail = false;
      now += RETRY_OFF_MS;
      await fireAlarm();
      expect(offs()).toHaveLength(2);
      expect(sqlite.query("SELECT status FROM device_operations WHERE action='power.off' ORDER BY requested_at").all()).toEqual([
        { status: "failed" }, { status: "succeeded" },
      ]);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("reads the rules again when they are edited", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { hub, sqlite, tell } = await fixture({}, { onForMinutes: 0 });
    try {
      await tell({ kind: "on", deviceId: "m1" });
      expect(await hub.idleSchedule()).toEqual({});
      sqlite.run("UPDATE app_settings SET value_json=? WHERE key=?", [JSON.stringify(deviceRule()), IDLE_SETTINGS_KEY]);
      await tell({ kind: "settings" });
      expect(await hub.idleSchedule()).toEqual({ m1: start + 10 * MIN });
      now = start + MIN;
      sqlite.run("UPDATE app_settings SET value_json=? WHERE key=?", [JSON.stringify({ ...deviceRule(), devices: { m1: { exclude: true } } }), IDLE_SETTINGS_KEY]);
      await tell({ kind: "settings" });
      expect(await hub.idleSchedule()).toEqual({});
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a device switched on when nothing watches it on a timer of its own activity", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { tell, fireAlarm, offs, state } = await fixture(deviceRule(), { watched: false, onForMinutes: 0 });
    const spy = haCalls();
    try {
      // Nothing reports it: without a signal the hub does not know it is on.
      await tell();
      expect(timersOf(state).entries).toEqual({});
      await tell({ kind: "activity", deviceId: "m1" });
      now = start + 10 * MIN;
      await fireAlarm();
      expect(offs()).toHaveLength(1);
      // Nothing will confirm it: the accepted power-off ends the timer.
      expect(timersOf(state).entries).toEqual({});
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });

  it("does not lose a signal that arrives while a power-off is waiting on Home Assistant", async () => {
    const start = Date.now();
    let now = start;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const { sqlite, tell, hub, state, connectionId } = await fixture(deviceRule(), { onForMinutes: 0 });
    sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('m2','p2','shop','中二','')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop','m2','power',?,'{}','2026-01-01','2026-01-01')`,
      [JSON.stringify({ connectionId, entityId: "switch.m2" })],
    );
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const spy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      await waiting;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch);
    try {
      await tell({ kind: "on", deviceId: "m1" });
      now = start + 10 * MIN;
      const off = hub.alarm();
      const coin = tell({ kind: "activity", deviceId: "m2" });
      release();
      await Promise.all([off, coin]);
      expect(Object.keys(timersOf(state).entries).some((key) => key.includes("switch.m2"))).toBe(true);
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  });
});
