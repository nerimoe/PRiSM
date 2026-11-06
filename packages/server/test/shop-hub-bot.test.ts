import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { sha256Hex } from "../src/crypto.js";
import { ShopHub } from "../src/durable-objects/shop-hub.js";
import { botRequestUrl, parseBotFrame } from "../src/durable-objects/shop-hub-bot.js";

const migrations = resolve(import.meta.dir, "../../../migrations");
const TOKEN = "integration_test_token";

class FakeSocket {
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

async function fixture() {
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
  const env = {
    DB: createD1DatabaseFromSqlite(sqlite),
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
      "这个命令平台还不认识，请更新 Bot 或联系店员",
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
