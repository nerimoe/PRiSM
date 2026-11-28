import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, AuthUser, Env } from "../src/bindings.js";
import { deviceEventSchema } from "@prism/storage-sql";
import { MachineRelay } from "../src/durable-objects/machine-relay.js";
import { merchantResourceRouter } from "../src/routes/platform/merchant-resources.js";
import { MAX_HOST_FILE_BYTES } from "../src/hardware/node-protocol.js";

class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: Database) {}
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...values: SqlValue[]) {
        return {
          async first<T = unknown>() {
            return (db.query(sql).get(...values) as T | null) ?? null;
          },
          async all<T = unknown>() {
            return { results: db.query(sql).all(...values) as T[] };
          },
          async run() {
            const result = db.run(sql, values);
            return { meta: { changes: result.changes } };
          },
        };
      },
    };
  }
  async batch(statements: readonly D1BoundStatementLike[]) {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  }
}

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

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE shops(
      id TEXT PRIMARY KEY, public_id TEXT NOT NULL, name TEXT NOT NULL,
      latitude REAL NOT NULL, longitude REAL NOT NULL, radius_meters INTEGER NOT NULL,
      hero_data TEXT, hero_hash TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE machines(
      shop_id TEXT NOT NULL, id TEXT NOT NULL, public_id TEXT NOT NULL, name TEXT NOT NULL,
      hinata_url_encrypted TEXT NOT NULL DEFAULT '', hinata_password_encrypted TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'machine',
      ha_binding_encrypted TEXT, ttlock_lock_id INTEGER, coin_key INTEGER NOT NULL DEFAULT 32,
      coin_after_swipe INTEGER NOT NULL DEFAULT 0, mahjong_config_json TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resource_group_id TEXT, pricing_config_override_id TEXT, capacity INTEGER NOT NULL DEFAULT 0,
      occupancy_minutes INTEGER NOT NULL DEFAULT 15, PRIMARY KEY(shop_id, id)
    );
    CREATE TABLE shop_members(shop_id TEXT, user_id TEXT, role TEXT);
    CREATE TABLE shop_staff_accounts(shop_id TEXT, staff_id TEXT, user_id TEXT);
    CREATE TABLE staff_users(shop_id TEXT, id TEXT, role TEXT, status TEXT);
    CREATE TABLE app_settings(shop_id TEXT, key TEXT, value_json TEXT, updated_at TEXT, PRIMARY KEY(shop_id,key));
    CREATE TABLE players(shop_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', PRIMARY KEY(shop_id, id));
  `);
  for (const statement of deviceEventSchema) sqlite.exec(statement);

  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters) VALUES ('shop-1','shop-code','Test Shop',0,0,80)");
  sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,enabled) VALUES ('shop-1','pc-1','pub-pc-1','PC-1',1)");
  sqlite.run(
    `INSERT INTO shop_nodes(shop_id,id,kind,name,enabled,channel,credential_hash,config_json,created_at,updated_at)
     VALUES ('shop-1','ln-1','launcher','PC-1 Launcher',1,'ln_chan1','hash_ln','{}','2026-01-01','2026-01-01')`,
  );
  sqlite.run(
    `INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,credential_hash,created_at,updated_at)
     VALUES ('shop-1','pc-1','host',?,'{}',NULL,'2026-01-01','2026-01-01')`,
    [JSON.stringify({ nodeId: "ln-1", defaultProgram: null, programs: [] })],
  );

  sqlite.run("INSERT INTO shop_members(shop_id,user_id,role) VALUES ('shop-1','owner-1','owner'),('shop-1','readonly-1','staff')");
  sqlite.run("INSERT INTO staff_users(shop_id,id,role,status) VALUES ('shop-1','st-mgr','manager','active'),('shop-1','st-clerk','clerk','active')");
  sqlite.run("INSERT INTO shop_staff_accounts(shop_id,staff_id,user_id) VALUES ('shop-1','st-mgr','mgr-1'),('shop-1','st-clerk','clerk-1')");

  const callLogs: Array<{ method: string; params: Record<string, unknown>; options?: { id?: string; expiresAt?: number; timeoutMs?: number } }> = [];
  let nextReply: { ok: boolean; result?: unknown; error?: string } = { ok: true, result: {} };

  const db = new SqliteD1(sqlite);
  const env = {
    DB: db,
    SESSION_SECRET: "session-secret",
    URL_ENCRYPTION_KEY: "unit-test-encryption-key",
    APP_ORIGIN: "https://prism.test",
    MACHINE_RELAY: {
      getByName: () => ({
        async nodeStatus() {
          return { online: true, kind: "launcher" as const, version: "0.2.0", model: "windows-x86_64", program: null, e2ee: false };
        },
        async pushConfig() {
          return { delivered: true };
        },
        async callNode(method: string, params: Record<string, unknown>, options?: { id?: string; expiresAt?: number; timeoutMs?: number }) {
          callLogs.push({ method, params, options });
          return nextReply;
        },
      }),
    },
  } as unknown as Env;

  let currentUser: AuthUser = { id: "owner-1", role: "user", username: "owner", displayName: "Owner", bannedAt: null };
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("user", currentUser);
    await next();
  });
  app.route("/api/v1/merchant", merchantResourceRouter);

  return {
    app,
    env,
    sqlite,
    callLogs,
    setUser: (user: AuthUser) => {
      currentUser = user;
    },
    setReply: (reply: { ok: boolean; result?: unknown; error?: string }) => {
      nextReply = reply;
    },
  };
}

describe("merchant host file management & PowerShell routes", () => {
  it("enforces merchant staff write permissions on host commands and config", async () => {
    const { app, env, setUser, setReply } = fixture();
    const sendCmd = (body: unknown) =>
      app.fetch(
        new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
      );

    // Read-only / non-manager staff & outsiders are rejected with 403.
    for (const userId of ["readonly-1", "clerk-1", "stranger-1"]) {
      setUser({ id: userId, role: "user", username: userId, displayName: userId, bannedAt: null });
      const res = await sendCmd({ action: "powershell", script: "Get-Date" });
      expect(res.status).toBe(403);
      const fsRes = await sendCmd({ action: "fs.list", path: "D:\\Games" });
      expect(fsRes.status).toBe(403);
    }

    // Active manager staff is allowed.
    setUser({ id: "mgr-1", role: "user", username: "mgr", displayName: "Manager", bannedAt: null });
    setReply({ ok: true, result: { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 42 } });
    const mgrRes = await sendCmd({ action: "powershell", script: "Write-Output ok" });
    expect(mgrRes.status).toBe(200);
    expect(await mgrRes.json()).toMatchObject({ ok: true, result: { stdout: "ok\n", exitCode: 0, timedOut: false } });
  });

  it("scales DO timeout dynamically for PowerShell and keeps transient script/content out of device_events", async () => {
    const { app, env, sqlite, callLogs, setReply } = fixture();

    setReply({ ok: true, result: { stdout: "done", stderr: "", exitCode: 0, timedOut: false, durationMs: 120 } });
    const psRes = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "powershell", script: "Start-Sleep -Seconds 50", cwd: "D:\\Games", timeoutMs: 60_000, shell: "pwsh" }),
      }),
      env,
    );
    expect(psRes.status).toBe(200);
    expect(callLogs[0]!.method).toBe("host.powershell");
    expect(callLogs[0]!.params).toMatchObject({ script: "Start-Sleep -Seconds 50", cwd: "D:\\Games", timeoutMs: 60_000, shell: "pwsh" });
    expect(callLogs[0]!.options?.timeoutMs).toBe(75_000);

    // Oversized fs.write rejected cleanly at route validation boundary.
    const bigRes = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fs.write", path: "D:\\Games\\big.txt", content: "x".repeat(MAX_HOST_FILE_BYTES + 1), encoding: "utf8" }),
      }),
      env,
    );
    expect(bigRes.status).toBe(422);

    // Valid fs.write sends content via transient without persisting content in device_events.
    setReply({ ok: true, result: { path: "D:\\Games\\note.txt", bytesWritten: 12 } });
    const writeRes = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "fs.write", path: "D:\\Games\\note.txt", content: "secret-body!", encoding: "utf8" }),
      }),
      env,
    );
    expect(writeRes.status).toBe(200);
    const storedEvents = sqlite.query<{ payload_json: string }, []>("SELECT payload_json FROM device_events").all();
    const joined = storedEvents.map((e) => e.payload_json).join("\n");
    expect(joined).not.toContain("secret-body!");
    expect(joined).not.toContain("\"stdout\":\"done\"");
  });

  it("saves and preserves allowedRoots in host config", async () => {
    const { app, env } = fixture();
    const put1 = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programs: [{ name: "kof", path: "D:\\Games\\kof.exe" }], defaultProgram: "kof", allowedRoots: ["D:\\Games"] }),
      }),
      env,
    );
    expect(put1.status).toBe(200);

    // Subsequent PUT omitting allowedRoots preserves the existing allowedRoots.
    const put2 = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programs: [{ name: "kof", path: "D:\\Games\\kof.exe" }], defaultProgram: "kof" }),
      }),
      env,
    );
    expect(put2.status).toBe(200);
    const getHost = await app.fetch(new Request("https://prism.test/api/v1/merchant/machines/pc-1/host"), env);
    expect(await getHost.json()).toMatchObject({
      config: { default: "kof", allowedRoots: ["D:\\Games"] },
    });
  });

  it("enforces MachineRelay outbound WebSocket frame cap and custom timeout", async () => {
    const state = new Map<string, unknown>();
    const sockets: FakeSocket[] = [];
    const ctx = {
      storage: {
        async get<T>(key: string) { return state.get(key) as T | undefined; },
        async put(key: string, value: unknown) { state.set(key, value); },
        async delete(key: string) { return state.delete(key); },
        async getAlarm() { return null; },
        async setAlarm() {},
        async deleteAlarm() {},
      },
      acceptWebSocket(ws: FakeSocket) { sockets.push(ws); },
      getWebSockets() { return sockets; },
    };
    const relay = new MachineRelay(ctx as any, {} as any);
    await relay.fetch(
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

    const oversized = await relay.callNode("host.fs.write", { path: "D:\\a.txt", content: "a".repeat(1_050_000) });
    expect(oversized.ok).toBe(false);
    expect(oversized.error).toContain("WebSocket");
  });
});


describe("Launcher update checks", () => {
  it("relays the update check and returns the pending version", async () => {
    const { app, env, callLogs, setReply } = fixture();
    setReply({ ok: true, result: { status: "pending", version: "0.3.0" } });
    const res = await app.fetch(new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/commands", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update.check" }),
    }), env);
    expect(res.status).toBe(200);
    expect(callLogs[0]?.method).toBe("host.update.check");
    expect(callLogs[0]?.options?.timeoutMs).toBe(95_000);
    expect(await res.json()).toMatchObject({ ok: true, result: { status: "pending", version: "0.3.0" } });
  });
  it("rejects update checks from ordinary clerks", async () => {
    const { app, env, setUser, callLogs } = fixture();
    setUser({ id: "clerk-1", role: "user", username: "clerk", displayName: "Clerk", bannedAt: null });
    const res = await app.fetch(new Request("https://prism.test/api/v1/merchant/machines/pc-1/host/commands", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update.check" }),
    }), env);
    expect(res.status).toBe(403);
    expect(callLogs).toHaveLength(0);
  });
});
