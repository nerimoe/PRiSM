import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite, type SqliteD1PreparedStatement } from "../src/local-server.js";
import { sha256Hex } from "../src/crypto.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";
import { botRequestUrl, parseBotFrame } from "../src/durable-objects/shop-hub-bot.js";
import { ensureBotResource } from "../src/resources/bot.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const TOKEN = "integration_test_token";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  attachment: unknown = null;
  closed: { code?: number; reason?: string } | null = null;
  send(payload: string) { this.sent.push(payload); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}

beforeEach(() => {
  (globalThis as any).WebSocketPair = class {
    0 = new FakeSocket();
    1 = new FakeSocket();
  };
});
afterEach(() => {
  delete (globalThis as any).WebSocketPair;
});

async function fixture(options: { databaseLatency?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=OFF");
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','A',0,0,80,'u')");
  sqlite.run("INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register) VALUES ('shop',1,1)");
  sqlite.run(
    `INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at)
     VALUES ('shop','t1','bot','integration','integ',?, 'active', '2026-01-01')`,
    [await sha256Hex(TOKEN)],
  );
  const sockets: FakeSocket[] = [];
  const state = new Map<string, unknown>();
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    storage: {
      async get<T>(key: string) { return structuredClone(state.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { state.set(key, structuredClone(value)); },
      async delete(key: string | string[]) { for (const k of [key].flat()) state.delete(k); return true; },
      async list({ prefix }: { prefix: string }) { return new Map([...state].filter(([k]) => k.startsWith(prefix))); },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    acceptWebSocket(ws: FakeSocket) { sockets.push(ws); },
    getWebSockets() { return sockets; },
    waitUntil(task: Promise<unknown>) { tasks.push(task); },
  };
  const db = createD1DatabaseFromSqlite(sqlite);
  if (options.databaseLatency) {
    const originalPrepare: (sql: string) => SqliteD1PreparedStatement = db.prepare;
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = async <T>() => {
          const result = await first<T>();
          // D1 yields to other requests while a database round trip completes.
          await new Promise((resolve) => setTimeout(resolve, 1));
          return result;
        };
        return bound;
      };
      return statement;
    };
  }
  const env = {
    DB: db,
    SESSION_SECRET: "s",
    RATE_LIMIT_5: { limit: async () => ({ success: true }) },
  };
  const hub = new ShopHub(ctx as any, env as any);
  const response = await hub.fetch(new Request("https://prism.test/api/v1/shops/shop-code/integration/ws", {
    headers: { Upgrade: "websocket", authorization: `Bearer ${TOKEN}`, "x-prism-hub-shop": "shop", "x-prism-hub-shop-code": "shop-code" },
  }));
  expect(response.status).toBe(101);
  const ws = sockets[0]!;
  const send = async (frame: unknown) => {
    await hub.webSocketMessage(ws as any, JSON.stringify(frame));
    return JSON.parse(ws.sent.at(-1) ?? "null");
  };
  return { sqlite, hub, ws, send, state };
}

describe("bot connection", () => {
  for (const limit of [30, 5]) it(`answers concurrent public-code redemptions without rejecting valid players (limit=${limit})`, async () => {
    const { hub, ws, sqlite } = await fixture({ databaseLatency: true });
    try {
      sqlite.run(`INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','coupon','gift','活动券',1,'active')`);
      sqlite.run(`INSERT INTO presents(shop_id,id,name,once_per_player,grants_json) VALUES ('shop','gift','活动礼物',1,?)`,
        [JSON.stringify([{ assetType: "coupon", assetCode: "gift", amount: 1, mergeStrategy: "stack" }])]);
      sqlite.run(`INSERT INTO redeem_codes(shop_id,id,code,present_id,max_use_count) VALUES ('shop','shared','PUBLIC','gift',?)`, [limit]);
      for (let i = 0; i < 20; i++) {
        sqlite.run(`INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop',?,?,'active','2026-01-01')`, [`p${i}`, `P${i}`]);
        sqlite.run(`INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop',?,'onebot',?,'2026-01-01')`, [`p${i}`, `player-${i}`]);
      }
      const redeem = (id: string, subject: string) => hub.webSocketMessage(ws as any, JSON.stringify({
        type: "request", id, method: "POST", path: "integration/players/by-identity/redeem",
        body: { identity: { provider: "onebot", subject }, code: "PUBLIC" },
      }));
      await Promise.all(Array.from({ length: 20 }, (_, i) => redeem(`redeem-${i}`, `player-${i}`)));
      const replies = ws.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "response");
      expect(replies).toHaveLength(20);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(Math.min(limit, 20));
      expect(replies.filter((reply) => reply.status !== 200).map((reply) => reply.body.error.code))
        .toEqual(Array(Math.max(20 - limit, 0)).fill("REDEEM_CODE_MAX_USE_REACHED"));
      const firstPlayer = (sqlite.query(`SELECT i.subject FROM redeem_records r JOIN player_identities i ON i.shop_id=r.shop_id AND i.player_id=r.player_id LIMIT 1`).get() as { subject: string }).subject;
      await redeem("repeat", firstPlayer);
      const repeat = JSON.parse(ws.sent.at(-1)!);
      expect(repeat.body.error.code).toBe(limit === 5 ? "REDEEM_CODE_MAX_USE_REACHED" : "PRESENT_ONCE_PER_PLAYER_REDEEMED");
      expect((sqlite.query("SELECT COUNT(*) AS n FROM redeem_records").get() as { n: number }).n).toBe(Math.min(limit, 20));
      expect((sqlite.query("SELECT COUNT(*) AS n FROM asset_transactions").get() as { n: number }).n).toBe(Math.min(limit, 20));
      expect((sqlite.query("SELECT COUNT(*) AS n FROM operation_locks").get() as { n: number }).n).toBe(0);
    } finally { sqlite.close(); }
  });

  it("finds a legacy live socket without an HA watch and backfills its credential usage", async () => {
    const { hub, ws, sqlite } = await fixture();
    const bot = await ensureBotResource(createD1DatabaseFromSqlite(sqlite), "shop", { id: "t1", label: "bot" });
    const usedAt = () => (sqlite.query("SELECT last_used_at FROM api_tokens WHERE id='t1'").get() as { last_used_at: string | null }).last_used_at;
    expect(usedAt()).toBeNull();
    expect(await hub.connectedBots()).toEqual([bot.id]);
    const firstUse = usedAt();
    expect(Number.isFinite(Date.parse(firstUse!))).toBe(true);
    expect(await hub.connectedBots()).toEqual([bot.id]);
    expect(usedAt()).toBe(firstUse);
    ws.readyState = 3;
    expect(await hub.connectedBots()).toEqual([]);
    // Offline is distinct from never connected.
    expect(usedAt()).toBe(firstUse);
    sqlite.close();
  });

  it("excludes live sockets whose resource is disabled or whose credential is revoked or rotated", async () => {
    const { hub, sqlite } = await fixture();
    const bot = await ensureBotResource(createD1DatabaseFromSqlite(sqlite), "shop", { id: "t1", label: "bot" });
    sqlite.run("UPDATE machines SET enabled=0 WHERE id=?", [bot.id]);
    expect(await hub.connectedBots()).toEqual([]);
    sqlite.run("UPDATE machines SET enabled=1 WHERE id=?", [bot.id]);
    sqlite.run("UPDATE api_tokens SET status='revoked' WHERE id='t1'");
    expect(await hub.connectedBots()).toEqual([]);
    sqlite.run("UPDATE api_tokens SET status='active',token_hash=? WHERE id='t1'", [await sha256Hex("rotated-token")]);
    expect(await hub.connectedBots()).toEqual([]);
    expect((sqlite.query("SELECT last_used_at FROM api_tokens WHERE id='t1'").get() as { last_used_at: string | null }).last_used_at).toBeNull();
    sqlite.close();
  });

  it("runs a request through the shop's integration routes with the bot's token", async () => {
    const { send, sqlite } = await fixture();
    const reply = await send({ type: "request", id: "r1", method: "GET", path: "integration/sessions/active" });
    expect(reply).toMatchObject({ type: "response", id: "r1", status: 200, body: { data: { sessions: [] } } });
    // The platform's own time comes back with it, for the Bot's speed test.
    expect(typeof reply.serverMs).toBe("number");
    sqlite.close();
  });

  it("answers a resent write from memory instead of running it twice", async () => {
    const { send, sqlite } = await fixture();
    const frame = {
      type: "request", id: "w1", method: "POST", path: "integration/players/by-identity/register",
      body: { identity: { provider: "onebot", subject: "10001" }, displayName: "A" },
    };
    const first = await send(frame);
    expect(first.status).toBe(200);
    const second = await send(frame);
    expect(second).toEqual(first);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM players").get() as { n: number }).n).toBe(1);
    sqlite.close();
  });

  it("refuses paths outside the shop's integration routes", async () => {
    const { send, sqlite } = await fixture();
    expect((await send({ type: "request", id: "x", method: "GET", path: "staff/settings" })).status).toBe(404);
    expect((await send({ type: "request", id: "y", method: "GET", path: "integration/../staff/settings" })).status).toBe(404);
    sqlite.close();
  });

  it("ends the connection once its token is revoked", async () => {
    const { send, ws, sqlite } = await fixture();
    sqlite.run("UPDATE api_tokens SET status='revoked'");
    const reply = await send({ type: "request", id: "r2", method: "GET", path: "integration/sessions/active" });
    expect(reply.status).toBe(403);
    expect(ws.closed?.code).toBe(4003);
    sqlite.close();
  });

  it("pushes idle reminders to the bot and learns how early it wants them", async () => {
    const { hub, ws, send, sqlite, state } = await fixture();
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", reminderLeadSeconds: 300 }));
    expect((ws.attachment as { reminderLeadMs: number }).reminderLeadMs).toBe(300_000);
    expect(state.has("touchAt")).toBe(true);
    await (hub as any).notify([{ reason: "shop_empty", at: 1, devices: [{ id: "m1", name: "舞萌" }] }]);
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: "event", event: "idle.reminder", data: { reason: "shop_empty", at: 1, devices: [{ id: "m1", name: "舞萌" }] },
    });
    void send;
    sqlite.close();
  });
});

describe("bot connection route", () => {
  it("hands an authenticated upgrade to the shop's hub, and refuses a bad token", async () => {
    const { createApp } = await import("../src/app.js");
    const { sqlite } = await fixture();
    const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "s" } as any;
    const forwarded: Request[] = [];
    // Workers only builds a 101 response together with its WebSocket; copying a response
    // as `new Response(body, response)` keeps it, rebuilding from status and headers does not.
    const BunResponse = globalThis.Response;
    class WorkersResponse extends BunResponse {
      webSocket: WebSocket | null;
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (init?.status === 101 && !init.webSocket)
          throw new RangeError("Responses may only be constructed with status codes in the range 200 to 599, inclusive.");
        super(body, init);
        this.webSocket = init?.webSocket ?? null;
      }
    }
    globalThis.Response = WorkersResponse as typeof Response;
    const socket = { kind: "client end" } as unknown as WebSocket;
    env.SHOP_HUB = { getByName: () => ({ async fetch(request: Request) {
      forwarded.push(request);
      return new WorkersResponse(null, { status: 101, webSocket: socket });
    } }) };
    // One fixed path, like a device's `/io/ws`: the credential names the shop.
    const connect = (token: string) => createApp().fetch(new Request("https://prism.test/integration/ws", {
      headers: { Upgrade: "websocket", authorization: `Bearer ${token}`, origin: "https://prism.test" },
    }), env);
    expect((await connect("wrong")).status).toBe(403);
    expect((await connect("")).status).toBe(403);
    // Rejected before the hub: a bad credential learns nothing about the shop.
    expect(forwarded).toHaveLength(0);
    // No middleware may rebuild the handshake, or the Bot sees a 500.
    try {
      const handshake = await connect(TOKEN);
      expect(handshake.status).toBe(101);
      expect((handshake as InstanceType<typeof WorkersResponse>).webSocket).toBe(socket);
      // The hub is told which shop the credential belongs to.
      expect(forwarded.at(-1)?.headers.get("x-prism-hub-shop")).toBe("shop");
      expect(forwarded.at(-1)?.headers.get("x-prism-hub-shop-code")).toBe("shop-code");
      const used = sqlite.query("SELECT last_used_at FROM api_tokens WHERE shop_id='shop' AND status='active'").get() as { last_used_at: string | null };
      expect(used.last_used_at).not.toBeNull();
    } finally {
      globalThis.Response = BunResponse;
    }
    expect(forwarded[0]?.headers.get("x-prism-hub-shop")).toBe("shop");
    expect(forwarded[0]?.headers.get("x-prism-hub-shop-code")).toBe("shop-code");
    sqlite.close();
  });
});

describe("bot frames", () => {
  it("only reads well-formed requests", () => {
    expect(parseBotFrame("{")).toBeNull();
    expect(parseBotFrame(JSON.stringify({ type: "request", id: "", method: "GET", path: "integration/x" }))).toBeNull();
    expect(parseBotFrame(JSON.stringify({ type: "request", id: "a", method: "DELETE", path: "integration/x" }))).toBeNull();
    expect(parseBotFrame(JSON.stringify({ type: "hello", reminderLeadSeconds: -1 }))).toEqual({ type: "hello" });
  });

  it("maps paths to the shop's routes only", () => {
    expect(botRequestUrl("s", "integration/players/by-identity/wallet")?.pathname).toBe("/api/v1/shops/s/integration/players/by-identity/wallet");
    expect(botRequestUrl("s", "/version")?.pathname).toBe("/version");
    expect(botRequestUrl("s", "integration/sessions/active", { a: 1 })?.search).toBe("?a=1");
    expect(botRequestUrl("s", "player/me")).toBeNull();
  });
});
