import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, createD1DatabaseFromSqlite, openLocalDatabase } from "../src/local/database.js";
import { LocalObjectHost } from "../src/local/object-host.js";
import { startLocalRuntime } from "../src/local/runtime.js";
import { localRateLimit } from "../src/local/rate-limit.js";
import { pendingMigrations, upgradeLocalDatabase } from "../src/local/upgrade.js";
import { LocalWebSockets, type LocalServerSocket } from "../src/local/websockets.js";
import { cloudflareWebSockets, openWebSocketPair, useWebSocketPlatform, webSocketUpgrade } from "../src/platform/websocket.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  useWebSocketPlatform(cloudflareWebSockets);
});

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await Bun.sleep(5);
  }
};

/** A Durable Object using every part of the API the platform's objects use. */
class Probe {
  static alarms: string[] = [];
  static failNext = 0;
  constructor(public ctx: any, public env: any) {
    ctx.setWebSocketAutoResponse({ request: "ping", response: "pong" });
  }
  async fetch() {
    const { client, server } = openWebSocketPair();
    this.ctx.acceptWebSocket(server, ["probe"]);
    server.serializeAttachment({ who: "first" });
    // Sent before the connection exists: the client must still get it first.
    server.send("hello");
    return webSocketUpgrade(client);
  }
  async webSocketMessage(ws: WebSocket, message: string) {
    if (message === "bye") return ws.close(4000, "done");
    ws.send(`${message}:${(ws as any).deserializeAttachment().who}:${this.ctx.getWebSockets("probe").length}`);
  }
  static closedCount = 0;
  async webSocketClose(_ws: WebSocket, code: number) {
    await this.ctx.storage.put("closed", code);
    Probe.closedCount += 1;
  }
  async remember(value: { list: number[] }) {
    value.list.push(99); // the caller's copy must not change
    await this.ctx.storage.put("value", value);
    const read = await this.ctx.storage.get("value");
    read.list.push(100); // nor the stored one
    return this.ctx.storage.get("value");
  }
  async armIn(ms: number) {
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }
  async closed() {
    return this.ctx.storage.get("closed");
  }
  async alarm(info: { retryCount: number }) {
    Probe.alarms.push(`${this.ctx.id.name}:${info.retryCount}:${await this.ctx.storage.getAlarm()}`);
    if (Probe.failNext-- > 0) throw new Error("try again");
  }
}

function host(db = new Database(":memory:")) {
  const sockets = new LocalWebSockets();
  useWebSocketPlatform(sockets);
  const objects = new LocalObjectHost(db, sockets);
  const namespace = objects.namespace<{
    remember(value: { list: number[] }): Promise<{ list: number[] }>;
    armIn(ms: number): Promise<void>;
    closed(): Promise<number | undefined>;
  }>("PROBE", Probe as never);
  objects.start({});
  cleanups.push(() => objects.stop());
  return { objects, sockets, namespace, db };
}

describe("local database", () => {
  it("builds the D1 schema from the migrations, once", () => {
    const db = new Database(":memory:");
    expect(applyMigrations(db).length).toBeGreaterThan(40);
    expect(applyMigrations(db)).toEqual([]);
    expect(pendingMigrations(db)).toEqual([]);
    // The SQLite macOS ships renames with legacy references; D1 does not.
    const effects = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE sql LIKE '%pricing_effects__tenant%'").all();
    expect(effects).toEqual([]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("runs a batch in one transaction no other request can join", async () => {
    const sqlite = new Database(":memory:");
    sqlite.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    const db = createD1DatabaseFromSqlite(sqlite);
    const other = db.prepare("INSERT INTO t (v) VALUES ('other')").bind().run();
    const failing = db.batch([
      db.prepare("INSERT INTO t (v) VALUES ('a')").bind(),
      db.prepare("INSERT INTO t (v) VALUES (NULL)").bind(),
    ]);
    await expect(failing).rejects.toThrow();
    await other;
    expect(sqlite.query("SELECT v FROM t").all()).toEqual([{ v: "other" }]);
  });
});

describe("local object host", () => {
  it("copies values in and out of storage and across a call", async () => {
    const { namespace } = host();
    const sent = { list: [1] };
    expect(await namespace.getByName("a").remember(sent)).toEqual({ list: [1, 99] });
    expect(sent).toEqual({ list: [1] });
    // One instance per name, reached by name or by id.
    const byId = namespace.get(namespace.idFromName("a"));
    expect(await byId.remember({ list: [] })).toEqual({ list: [99] });
  });

  it("fires an alarm cleared beforehand, retries a failure and keeps it across a restart", async () => {
    Probe.alarms = [];
    Probe.failNext = 1;
    const db = new Database(":memory:");
    const first = host(db);
    await first.namespace.getByName("x").armIn(10);
    await until(() => Probe.alarms.length === 1);
    expect(Probe.alarms[0]).toBe("x:0:null");
    // The failed alarm is retried after a backoff; restart before it is due.
    first.objects.stop();
    const second = host(db);
    expect(db.query("SELECT retries FROM object_alarms").get()).toEqual({ retries: 1 });
    db.run("UPDATE object_alarms SET at = ?", [Date.now()]);
    second.objects.stop();
    host(db);
    await until(() => Probe.alarms.length === 2);
    expect(Probe.alarms[1]).toBe("x:1:null");
    expect(db.query("SELECT COUNT(*) AS n FROM object_alarms").get()).toEqual({ n: 0 });
  });

  it("joins an upgrade to the accepted socket, as the hibernation API does", async () => {
    const { sockets, namespace } = host();
    const server = Bun.serve<LocalServerSocket, never>({
      port: 0,
      async fetch(request, server) {
        const response = await namespace.getByName("ws").fetch(request);
        return response.status === 101 ? sockets.complete(request, response, server) : response;
      },
      websocket: sockets.handler,
    });
    cleanups.push(() => Promise.race([server.stop(true), Bun.sleep(200)]));
    const client = new WebSocket(`ws://localhost:${server.port}/`);
    const received: string[] = [];
    client.addEventListener("message", (event) => received.push(String(event.data)));
    await new Promise((resolve) => client.addEventListener("open", resolve, { once: true }));
    client.send("ping");
    client.send("hi");
    await until(() => received.length === 3);
    expect(received).toEqual(["hello", "pong", "hi:first:1"]);
    client.send("bye");
    await until(() => client.readyState === WebSocket.CLOSED);
    await until(() => Probe.closedCount > 0);
    expect(await namespace.getByName("ws").closed()).toBe(4000);
  });
});

describe("local platform pieces", () => {
  it("counts a rate limit per key in a fixed window, like the Workers binding", async () => {
    const limiter = localRateLimit(2);
    expect((await limiter.limit({ key: "a" })).success).toBe(true);
    expect((await limiter.limit({ key: "a" })).success).toBe(true);
    expect((await limiter.limit({ key: "a" })).success).toBe(false);
    expect((await limiter.limit({ key: "b" })).success).toBe(true);
  });

  it("opens an outbound socket (Home Assistant) with Bun's WebSocket", async () => {
    const echo = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("no", { status: 400 })),
      websocket: { message: (ws, message) => { ws.send(`echo:${message}`); } },
    });
    cleanups.push(() => Promise.race([echo.stop(true), Bun.sleep(200)]));
    const socket = await new LocalWebSockets().connect(`ws://localhost:${echo.port}/api/websocket`);
    const reply = new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data))));
    socket.send("auth");
    expect(await reply).toBe("echo:auth");
    socket.close();
    await expect(new LocalWebSockets().connect("ws://localhost:1/none")).rejects.toThrow(/refused/);
  });
});

describe("local runtime", () => {
  it("refuses to start before the upgrade, then serves the Worker's routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prism-local-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const databasePath = join(dir, "prism.sqlite");
    openLocalDatabase(databasePath).close();
    expect(() => startLocalRuntime({ databasePath, port: 0, cron: false })).toThrow(/local:upgrade/);
    const upgraded = await upgradeLocalDatabase({ databasePath });
    expect(upgraded.backup).toContain("before-upgrade");
    expect(upgraded.applied.length).toBeGreaterThan(40);
    const runtime = startLocalRuntime({ databasePath, port: 0, cron: false, env: { PRISM_DEPLOY_REVISION: "abc" } });
    cleanups.push(() => runtime.stop());
    // The running server holds the database: an upgrade now is refused.
    await expect(upgradeLocalDatabase({ databasePath })).rejects.toThrow(/stop it first/);
    const health = await fetch(`http://localhost:${runtime.server.port}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-prism-revision")).toBe("abc");
    expect(runtime.env.SHOP_HUB).toBeDefined();
    // Routes that refuse to run without the Workers rate-limit bindings get local ones.
    expect(runtime.env.RATE_LIMIT_10).toBeDefined();
  });
});
