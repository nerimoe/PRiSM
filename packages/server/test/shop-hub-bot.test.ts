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
  tags: string[] | null = null;
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
    acceptWebSocket(ws: FakeSocket, tags?: string[]) { ws.tags = tags ?? null; sockets.push(ws); },
    getWebSockets(tag?: string) { return tag ? sockets.filter((ws) => !ws.tags || ws.tags.includes(tag)) : sockets; },
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
  return { sqlite, hub, ws, send, state, sockets, env };
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
      // The message comes along, for a bot that says what the platform writes.
      type: "event", event: "idle.reminder", data: { reason: "shop_empty", at: 1, devices: [{ id: "m1", name: "舞萌" }], message: [{ text: "店里没人，1 分钟后全部关机" }] },
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

describe("what a bot is told", () => {
  /** A bot resource holding the test token, set to announce `types`. */
  function botResource(sqlite: Database, types: string[] | null) {
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','bot-res','pub-bot','前台 Bot','')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop','bot-res','bot',?,'{}','2026-01-01','2026-01-01')`,
      [JSON.stringify({ tokenId: "t1", announceEvents: types })],
    );
  }
  const event = (type: string, extra: Record<string, unknown> = {}) =>
    ({ type, label: type, message: [{ text: `${type} 的话` }], resourceId: "m1", resourceName: "舞萌", player: null, ...extra });
  const told = (ws: FakeSocket) =>
    ws.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "event").map((frame) => frame.data.type ?? frame.event);

  it("sends a bot that says the platform's message only what it is set to tell, and not its own commands", async () => {
    const { sqlite, hub, ws, send } = await fixture();
    botResource(sqlite, ["card", "idle.reminder"]);
    await send({ type: "hello", announcements: "message" });
    await hub.shopEvent(event("card"));
    await hub.shopEvent(event("power.on"));
    await hub.shopEvent(event("card", { botId: "bot-res" }));
    expect(told(ws)).toEqual(["card"]);
  });

  it("sends a bot that chooses for itself everything, as before", async () => {
    const { sqlite, hub, ws, send } = await fixture();
    botResource(sqlite, ["card"]);
    await send({ type: "hello" });
    await hub.shopEvent(event("card"));
    await hub.shopEvent(event("power.on"));
    expect(told(ws)).toEqual(["card", "power.on"]);
  });

  it("reads the choice again when the bot says hello again", async () => {
    const { sqlite, hub, ws, send } = await fixture();
    botResource(sqlite, ["card"]);
    await send({ type: "hello", announcements: "message" });
    sqlite.run(`UPDATE device_capabilities SET config_json=? WHERE device_id='bot-res'`, [JSON.stringify({ tokenId: "t1", announceEvents: ["power.on"] })]);
    await send({ type: "hello", announcements: "message" });
    await hub.shopEvent(event("card"));
    await hub.shopEvent(event("power.on"));
    expect(told(ws)).toEqual(["power.on"]);
  });
});

describe("a bot's commands", () => {
  function botResource(sqlite: Database, config: Record<string, unknown> = {}) {
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','bot-res','pub-bot','前台 Bot','')");
    sqlite.run(
      `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
       VALUES ('shop','bot-res','bot',?,'{}','2026-01-01','2026-01-01')`,
      [JSON.stringify({ tokenId: "t1", ...config })],
    );
  }
  const from = { provider: "onebot", subject: "10001", name: "一号" };
  const command = (id: string, name: string, args: string[] = [], extra: Record<string, unknown> = {}) =>
    ({ type: "command", id, name, args, from, channel: "onebot:42", ...extra });
  const says = (ws: FakeSocket) => ws.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.type === "say");
  const text = (frame: { message: Array<{ text?: string; player?: { displayName: string } }> }) =>
    frame.message.map((segment) => segment.text ?? `<${segment.player?.displayName}>`).join("");

  it("runs a command once and says its answer, as a reply to it", async () => {
    const { sqlite, hub, ws } = await fixture();
    botResource(sqlite);
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", commands: 1 }));
    await hub.webSocketMessage(ws as any, JSON.stringify(command("c1", "wallet")));
    await hub.webSocketMessage(ws as any, JSON.stringify(command("c1", "wallet")));
    const [first, again] = says(ws);
    expect(first).toMatchObject({ type: "say", replyTo: "c1", done: true });
    expect(text(first)).toContain("💰 --- 钱包余额 ---");
    // Sent again after a lost answer: the same words, and nobody registered twice.
    expect(again).toEqual(first);
    expect((sqlite.query("SELECT COUNT(*) AS n FROM players").get() as { n: number }).n).toBe(1);
    sqlite.close();
  });

  it("decides who may do what: read-only mode, staff acting for others, and refusals in words", async () => {
    const { sqlite, hub, ws } = await fixture();
    botResource(sqlite, { playerCommands: "readonly", readOnlyNotice: "请扫码" });
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", commands: 1 }));
    await hub.webSocketMessage(ws as any, JSON.stringify(command("c1", "coin", ["mai"])));
    await hub.webSocketMessage(ws as any, JSON.stringify(command("c2", "wallet", [], { target: { provider: "onebot", subject: "10002" } })));
    await hub.webSocketMessage(ws as any, JSON.stringify(command("c3", "billing")));
    await hub.webSocketMessage(ws as any, JSON.stringify(command("c4", "nope")));
    expect(says(ws).map(text)).toEqual([
      "请扫码",
      "权限不足",
      // A refusal, in the bot's words.
      "您当前没有未结算的账单，无需结账。",
      "不支持这个命令",
    ]);
    sqlite.close();
  });

  it("tells a commands bot the shop's news as words for the places it announces in", async () => {
    const { sqlite, hub, ws } = await fixture();
    botResource(sqlite, { announceEvents: ["card"], announceChannelIds: ["onebot:42", "onebot:43"] });
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", commands: 1 }));
    await hub.shopEvent({ type: "card", message: [{ text: "💳 刷卡" }], resourceId: "m1", resourceName: "舞萌", player: null });
    await hub.shopEvent({ type: "power.on", message: [{ text: "✅ 开机" }], resourceId: "m1", resourceName: "舞萌", player: null });
    expect(says(ws)).toEqual([
      { type: "say", to: "onebot:42", message: [{ text: "💳 刷卡" }] },
      { type: "say", to: "onebot:43", message: [{ text: "💳 刷卡" }] },
    ]);
    expect(ws.sent.some((raw) => JSON.parse(raw).type === "event")).toBe(false);
    sqlite.close();
  });

  it("ends a commands bot's connection once its token is revoked", async () => {
    const { sqlite, hub, ws } = await fixture();
    botResource(sqlite);
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", commands: 1 }));
    sqlite.run("UPDATE api_tokens SET status='revoked'");
    await hub.botsChanged();
    expect(ws.closed?.code).toBe(4003);
    sqlite.close();
  });
});

describe("what a page drawn from /session/page hears", () => {
  async function shop() {
    const made = await fixture();
    const { sqlite, hub, env, ws } = made;
    (env as any).SHOP_HUB = { getByName: () => hub };
    sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','猫粮',1,'active'),('shop','currency','free','赠送',1,'active')");
    sqlite.run(
      "INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at) VALUES ('shop','base','time.priority','base',1,'active',?,'2026-01-01','2026-01-01')",
      [JSON.stringify({ id: "base", timeZone: "UTC", rules: [{ id: "r", label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" }, pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 } }] })],
    );
    sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认',1,'base','2026-01-01','2026-01-01')");
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','一号','active','2026-01-01')");
    sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop','u1','p1','2026-01-01')");
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','bot-res','pub-bot','前台 Bot','')");
    sqlite.run("INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) VALUES ('shop','bot-res','bot',?,'{}','2026-01-01','2026-01-01')", [JSON.stringify({ tokenId: "t1" })]);
    sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop','p1','onebot','1','2026-01-01')");
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "hello", commands: 1 }));
    const open = async (deviceId: string, userId: string, query = "?v=2") => {
      await hub.fetch(new Request(`https://prism.test/ws${query}`, { headers: { Upgrade: "websocket", "x-prism-hub-shop": "shop", "x-prism-hub-device": deviceId, "x-prism-hub-user": userId } }));
      return made.sockets.at(-1)!;
    };
    return { ...made, open };
  }
  const frames = (page: FakeSocket) => page.sent.map((raw) => JSON.parse(raw));
  const changed = (reason: string) => ({ method: "event.pageChanged", params: { reason } });

  it("is greeted with nothing, and costs the hub no reads to connect", async () => {
    const { sqlite, open } = await shop();
    expect(frames(await open("m1", "u1"))).toEqual([]);
    sqlite.close();
  });

  it("hears only what concerns it: its device, its player, or the whole shop", async () => {
    const { sqlite, hub, open } = await shop();
    const mine = await open("m1", "u1");
    const other = await open("m2", "u2");
    await hub.pagesChanged({ device: "m2" }, "coin");
    expect(frames(mine)).toEqual([]);
    expect(frames(other)).toEqual([changed("coin")]);
    await hub.pagesChanged({ player: "p1" }, "billing");
    expect(frames(mine)).toEqual([changed("billing")]);
    expect(frames(other)).toHaveLength(1);
    await hub.pagesChanged({ shop: true }, "shop");
    expect(frames(mine)).toHaveLength(2);
    expect(frames(other)).toHaveLength(2);
    sqlite.close();
  });

  it("hears at a mahjong table whoever's billing moved, as its seats follow sessions", async () => {
    const { sqlite, hub, open } = await shop();
    sqlite.run("INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at) VALUES ('shop','table','mahjong','{}','{}','2026-01-01','2026-01-01')");
    const table = await open("table", "u2");
    const elsewhere = await open("m1", "u2");
    await hub.pagesChanged({ player: "p1" }, "billing");
    expect(frames(table)).toEqual([changed("billing")]);
    expect(frames(elsewhere)).toEqual([]);
    sqlite.close();
  });

  it("hears a device's state change as a change, without the state", async () => {
    const { sqlite, hub, open } = await shop();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','m1','pub-m1','空调','')");
    const page = await open("m1", "u1");
    await hub.deviceRead("shop", "m1", { power: "on" });
    expect(frames(page)).toEqual([changed("device")]);
    sqlite.close();
  });

  it("hears a binding, and the shop's setup changing", async () => {
    const { sqlite, hub, open } = await shop();
    const page = await open("m1", "u1");
    await hub.notifyUser("u1", { type: "refresh", reason: "binding" });
    expect(frames(page)).toEqual([changed("binding")]);
    await hub.botsChanged();
    expect(frames(page).at(-1)).toEqual(changed("shop"));
    sqlite.close();
  });

  it("hears when a bot command moved the player's billing", async () => {
    const { sqlite, hub, ws, open } = await shop();
    const page = await open("m1", "u1");
    await hub.webSocketMessage(ws as any, JSON.stringify({ type: "command", id: "c1", name: "login", args: [], from: { provider: "onebot", subject: "1", name: "一号" }, channel: "onebot:9" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames(page).map((frame) => frame.method)).toContain("event.pageChanged");
    sqlite.close();
  });

  it("leaves a released client's channel as it was", async () => {
    const { sqlite, hub, open } = await shop();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','m1','pub-m1','空调','')");
    const old = await open("m1", "u1", "");
    expect(frames(old)[0].type).toBe("hello");
    const before = old.sent.length;
    await hub.pagesChanged({ player: "p1" }, "billing");
    await hub.pagesChanged({ shop: true }, "shop");
    expect(old.sent.length).toBe(before);
    await hub.deviceRead("shop", "m1", { power: "on" });
    expect(frames(old).at(-1)).toMatchObject({ type: "state", power: "on" });
    await hub.notifyUser("u1", { type: "refresh", reason: "binding" });
    expect(frames(old).at(-1)).toEqual({ type: "refresh", reason: "binding" });
    sqlite.close();
  });
});
