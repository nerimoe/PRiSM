import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1DatabaseFromSqlite, initializeLocalDatabase } from "../src/local-server.js";
import { MachineRelay } from "../src/durable-objects/machine-relay.js";

/** Records what the relay sends and keeps its attachment, like a hibernation socket. */
class FakeSocket {
  readonly sent: string[] = [];
  private attachment: unknown = null;
  send(payload: string) { this.sent.push(payload); }
  close() {}
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}

beforeEach(() => {
  (globalThis as any).WebSocketPair = class {
    readonly 0 = new FakeSocket();
    readonly 1 = new FakeSocket();
  };
});
afterEach(() => { delete (globalThis as any).WebSocketPair; });

const OP = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/** A relay for one cabinet of a real local schema, whose shop hub only records announcements. */
async function fixture() {
  const sqlite = new Database(":memory:");
  initializeLocalDatabase(sqlite);
  const shopId = sqlite.query<{ id: string }, []>("SELECT id FROM shops LIMIT 1").get()!.id;
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name) VALUES ('machine-1','pub-1',?,'舞萌左机')", [shopId]);
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
     VALUES (?,'machine-1','hinata_io','{"transport":"embedded","channel":"m_test"}','{}','2026-01-01','2026-01-01')`,
    [shopId],
  );
  const told: Array<Record<string, any>> = [];
  const hub = new Proxy({}, {
    get: (_, method) => method === "then" ? undefined
      : method === "shopEvent" ? async (event: Record<string, any>) => { told.push(event); }
      : async () => ({}),
  });
  const state = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage: {
      async get(key: string) { return state.get(key); },
      async put(key: string, value: unknown) { state.set(key, value); },
      async delete(key: string) { return state.delete(key); },
    },
    acceptWebSocket(ws: FakeSocket) { sockets.push(ws); },
    getWebSockets() { return sockets; },
  };
  const env = { DB: createD1DatabaseFromSqlite(sqlite), SHOP_HUB: { getByName: () => hub } };
  const relay = new MachineRelay(ctx as any, env as any);
  await relay.fetch(new Request("https://prism.test/io/ws", {
    headers: { Upgrade: "websocket", "x-prism-relay-shop": shopId, "x-prism-relay-machine": "machine-1" },
  }));
  const report = (method: string, params: Record<string, unknown>) =>
    relay.webSocketMessage(sockets[0] as any, JSON.stringify({ jsonrpc: "2.0", method, params }));
  return { relay, told, report, sqlite, sockets };
}

const read = (revision: number, credit: number, totalCoin: number, coinCredit: number) => ({
  revision, read_at_ms: 1793987190957 + revision,
  credit_config: { cost: [1, 1, 1, 1, 1, 1, 1, 1], coin_amount: 100 },
  players: [{ credit, remain: 0 }, { credit, remain: 0 }],
  bookkeeping: { coin_chute: [totalCoin], total_coin: totalCoin, coin_credit: coinCredit, service_credit: 0, emoney_coin: 0, emoney_credit: 0, total_credit: coinCredit },
});

describe("what a cabinet's books tell the platform", () => {
  it("tells each change once, from snapshots and heartbeats alike, and keeps the latest books", async () => {
    const { told, report, sqlite } = await fixture();
    await report("event.cabinetSnapshot", read(1, 4, 218, 59));
    expect(told).toEqual([]);
    await report("event.cabinetSnapshot", read(2, 5, 219, 60));
    // The beat repeats what is already known: nothing new.
    await report("io.heartbeat", { ha: [], cabinet: read(2, 5, 219, 60) });
    // A snapshot event was missed; the beat carries the whole difference.
    await report("io.heartbeat", { ha: [], cabinet: read(4, 4, 220, 60) });
    expect(told.map(({ type, detail }) => ({ type, detail }))).toEqual([
      { type: "cabinet.coin", detail: { coins: 1, credit: 5 } },
      { type: "cabinet.coin", detail: { coins: 1, credit: 4 } },
      { type: "cabinet.consumed", detail: { credits: 1, credit: 4 } },
    ]);
    expect(told.every((event) => event.label && !("kind" in event) && event.player === null)).toBe(true);
    const logged = sqlite.query<{ name: string }, []>("SELECT name FROM device_events WHERE kind='signal' ORDER BY rowid").all();
    expect(logged.map((row) => row.name)).toEqual(["cabinet.coin", "cabinet.coin", "cabinet.consumed"]);
    const state = sqlite.query<{ value_json: string }, []>(
      "SELECT value_json FROM device_state WHERE capability='hinata_io' AND key='cabinet'",
    ).get();
    expect(JSON.parse(state!.value_json)).toMatchObject({ players: [{ credit: 4 }, { credit: 4 }], bookkeeping: { totalCoin: 220 } });
  });

  it("asks the IO to read its books now and treats the answer as any report", async () => {
    const { relay, told, report, sockets } = await fixture();
    await report("event.cabinetSnapshot", read(1, 4, 218, 59));
    const reading = relay.readCabinet();
    const request = JSON.parse(sockets[0]!.sent.at(-1)!);
    expect(request).toMatchObject({ jsonrpc: "2.0", method: "cabinet.getSnapshot", params: {} });
    await relay.webSocketMessage(sockets[0] as any, JSON.stringify({ jsonrpc: "2.0", id: request.id, result: read(2, 3, 218, 59) }));
    expect(await reading).toMatchObject({ ok: true, cabinet: { players: [{ credit: 3, remain: 0 }, { credit: 3, remain: 0 }] } });
    expect(told.map(({ type }) => type)).toEqual(["cabinet.consumed"]);
  });

  it("passes on an IO that cannot read its books", async () => {
    const { relay, sockets } = await fixture();
    const reading = relay.readCabinet();
    const request = JSON.parse(sockets[0]!.sent.at(-1)!);
    await relay.webSocketMessage(sockets[0] as any, JSON.stringify({
      jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "cabinet monitor is disabled ([aimeio] cabinetMonitor=0)" },
    }));
    expect(await reading).toEqual({ ok: false, error: "这台 IO 没有读取机台状态（游戏没有 sysfile.dat，或 IO 版本太旧）" });
  });

  it("stores a failed read without comparing it, and compares the next good one with the last good one", async () => {
    const { told, report } = await fixture();
    await report("event.cabinetSnapshot", read(1, 4, 218, 59));
    await report("event.cabinetSnapshot", { revision: 2, read_at_ms: 2, error: "backup: copy differs" });
    expect(told).toEqual([]);
    await report("event.cabinetSnapshot", read(3, 3, 218, 59));
    expect(told.map(({ type }) => type)).toEqual(["cabinet.consumed"]);
  });
});

describe("what a cabinet's card reports tell the shop's bots", () => {
  it("tells a card the game took once, whether the platform sent it or it was on the reader", async () => {
    const { told, report } = await fixture();
    await report("event.cardConsumed", { interface: "aimeio", unit_no: 0, card: { source: OP } });
    await report("event.cardConsumed", { interface: "aimeio", unit_no: 0, card: { source: "HINATA(1)" } });
    expect(told.map(({ type, label, kind, resourceName }) => ({ type, label, kind, resourceName }))).toEqual([
      { type: "card", label: "刷卡", kind: "card", resourceName: "舞萌左机" },
      { type: "card", label: "刷卡", kind: "card", resourceName: "舞萌左机" },
    ]);
  });

  it("tells nothing for a card that is only on the reader", async () => {
    const { told, report } = await fixture();
    await report("event.cardStateChanged", { interface: "aimeio", unit_no: 0, card: { source: OP } });
    expect(told).toEqual([]);
  });

  it("answers a caller waiting on the card with the report, and only for its own operation", async () => {
    const { relay, report } = await fixture();
    const waiting = relay.sendCard({ accessCode: "01234567890123456789", source: OP, wait: { signal: "card.consumed", timeoutMs: 2000 } });
    await report("event.cardConsumed", { interface: "aimeio", unit_no: 0, card: { source: "7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" } });
    await report("event.cardConsumed", { interface: "aimeio", unit_no: 0, card: { source: OP } });
    expect(await waiting).toMatchObject({ ok: true, awaited: { name: "card.consumed", payload: { unit_no: 0 } } });
  });
});

describe("what an IO says of its readers", () => {
  const reader = (chip_id: string) =>
    ({ chip_id, name: "HINATA", firmware_timestamp: 20261001, commit_hash: "abcd1234" });
  const signals = (sqlite: Database) => (sqlite.query("SELECT name, payload_json FROM device_events WHERE kind='signal' AND name LIKE 'reader.%' ORDER BY rowid").all() as Array<{ name: string; payload_json: string }>)
    .map((row) => [row.name, JSON.parse(row.payload_json).chipId]);
  const stored = (sqlite: Database, key: string) => {
    const row = sqlite.query("SELECT value_json FROM device_state WHERE device_id='machine-1' AND capability='hinata_io' AND key=?").get(key) as { value_json: string } | null;
    return row ? JSON.parse(row.value_json) : null;
  };
  const hello = (relay: any, sockets: any[], body: Record<string, unknown>) =>
    relay.webSocketMessage(sockets[0], JSON.stringify({ action: "CLIENT_HELLO", body: { auth: "bearer", events: [], ...body } }));

  const beat = (report: any, readers: unknown[] | undefined) => report("io.heartbeat", { ha: [], ...(readers ? { readers } : {}) });

  it("turns cabinet reporting on for a token connection, in memory, and for no other", async () => {
    const { relay, sockets } = await fixture();
    const turnedOn = () => sockets[0]!.sent.some((sent: string) => sent.includes("io.setLiveConfig"));
    await hello(relay, sockets, { auth: undefined });
    expect(turnedOn()).toBe(false);
    await hello(relay, sockets, { e2ee: true });
    expect(turnedOn()).toBe(false);
    await hello(relay, sockets, {});
    expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toEqual({ jsonrpc: "2.0", method: "io.setLiveConfig", params: { key: "cabinetMonitor", value: "1" } });
  });

  it("keeps the version from the hello, which says nothing of readers", async () => {
    const { relay, sockets, sqlite } = await fixture();
    await hello(relay, sockets, { io: { version: "1.2.3" } });
    expect(stored(sqlite, "version")).toBe("1.2.3");
    expect(stored(sqlite, "readers")).toBeNull();
    sqlite.close();
  });

  const changed = (report: any, readers: unknown[], type?: string, one?: unknown) =>
    report("event.readersChanged", { readers, ...(type ? { change: { type, reader: one } } : {}) });

  it("replaces the list with whatever the IO last said, from a change or a heartbeat", async () => {
    const { sqlite, report } = await fixture();
    await beat(report, [reader("usb-1")]);
    expect(stored(sqlite, "readers")).toMatchObject([{ chipId: "usb-1", firmwareTimestamp: 20261001, commitHash: "abcd1234" }]);
    await changed(report, [reader("usb-1"), reader("usb-2")]);
    expect(stored(sqlite, "readers")).toHaveLength(2);
    await beat(report, []);
    expect(stored(sqlite, "readers")).toEqual([]);
    sqlite.close();
  });

  it("leaves the list alone when a heartbeat has none yet, and writes nothing when it is the same", async () => {
    const { sqlite, report } = await fixture();
    await beat(report, [reader("usb-1")]);
    await beat(report, undefined);
    expect(stored(sqlite, "readers")).toHaveLength(1);
    const at = () => sqlite.query("SELECT changed_at FROM device_state WHERE device_id='machine-1' AND key='readers'").get();
    sqlite.run("UPDATE device_state SET changed_at='2000-01-01' WHERE device_id='machine-1' AND key='readers'");
    await beat(report, [reader("usb-1")]);
    expect(at()).toEqual({ changed_at: "2000-01-01" });
    sqlite.close();
  });

  it("records what the IO says was plugged in and unplugged, and tells no bot", async () => {
    const { sqlite, report, told } = await fixture();
    await changed(report, [reader("usb-1")], "connected", reader("usb-1"));
    await changed(report, [], "disconnected", reader("usb-1"));
    expect(signals(sqlite)).toEqual([["reader.connected", "usb-1"], ["reader.disconnected", "usb-1"]]);
    expect(told).toEqual([]);
    sqlite.close();
  });

  it("records nothing for a list without a change, as when an IO starts up", async () => {
    const { sqlite, report } = await fixture();
    await changed(report, [reader("usb-1")]);
    await beat(report, []);
    expect(signals(sqlite)).toEqual([]);
    sqlite.close();
  });
});
