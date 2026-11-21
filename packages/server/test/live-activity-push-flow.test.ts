import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { Context } from "hono";
import type { AppBindings, Env } from "../src/bindings.js";
import { pushSessionEvent } from "../src/routes/shops/live-activity-events.js";
import type { ApnsTransport } from "../src/durable-objects/live-activity-push.js";

describe("Live Activity start-to-end APNs fanout", () => {
  it("delivers remote start and end for an account-bound visit and retires the session token", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE shop_player_accounts (shop_id TEXT, user_id TEXT, player_id TEXT);
      CREATE TABLE shops (id TEXT, public_id TEXT, name TEXT);
      CREATE TABLE sessions (shop_id TEXT, id TEXT, player_id TEXT, started_at TEXT, ended_at TEXT, payment_status TEXT);
      CREATE TABLE live_activity_start_tokens (
        id TEXT, token TEXT, environment TEXT, bundle_id TEXT, client_id TEXT,
        user_id TEXT, last_seen_at TEXT, updated_at TEXT
      );
      CREATE TABLE live_activity_tokens (
        id TEXT, token TEXT, environment TEXT, bundle_id TEXT, session_id TEXT,
        shop_id TEXT, user_id TEXT, created_at TEXT, updated_at TEXT, client_id TEXT
      );
      INSERT INTO shop_player_accounts VALUES ('shop', 'account', 'player');
      INSERT INTO shops VALUES ('shop', 'demo', 'Example');
      INSERT INTO sessions VALUES ('shop', 'session', 'player', '2026-10-08T01:00:00Z', NULL, 'unpaid');
      INSERT INTO live_activity_start_tokens VALUES ('start', 'abcdef123456', 'sandbox',
        'moe.neri.hinatago', 'iphone', 'account', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      -- An install that has not run for months: the app is gone, and it is pushed nothing.
      INSERT INTO live_activity_start_tokens VALUES ('gone', 'fedcba123456', 'sandbox',
        'moe.neri.hinatago', 'old-iphone', 'account', NULL, '2026-01-01T00:00:00.000Z');
      INSERT INTO live_activity_tokens VALUES ('activity', 'abcdef654321', 'sandbox',
        'moe.neri.hinatago', 'session', 'shop', 'account', '2026-10-08T01:00:00Z', NULL, 'other-iphone');
    `);

    const db = {
      prepare(sql: string) {
        return {
          bind(...values: any[]) {
            return {
              async first<T = unknown>(): Promise<T | null> {
                return (sqlite.query(sql).get(...values) as T | null) ?? null;
              },
              async all<T = unknown>(): Promise<{ results: T[] }> {
                return { results: sqlite.query(sql).all(...values) as T[] };
              },
              async run(): Promise<{ success: boolean }> {
                sqlite.run(sql, values);
                return { success: true };
              },
            };
          },
        };
      },
    };

    const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
    );
    const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
    const encoded = btoa(String.fromCharCode(...bytes));
    const pem = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
    const env = {
      DB: db, APP_ORIGIN: "https://link.example",
      APNS_KEY_ID: "ABC123", APNS_TEAM_ID: "TEAM123", APNS_PRIVATE_KEY: pem,
    } as unknown as Env;
    const c = { env } as Context<AppBindings>;
    const pushes: Array<{ headers: Record<string,string>; payload: any; url: string }> = [];
    const transport: ApnsTransport = async ({url,headers,body}) => {
      pushes.push({url,headers,payload:JSON.parse(body)});
      return { status: 200, body: "" };
    };

    await pushSessionEvent(c, {
      shopId: "shop", playerId: "player", sessionIds: ["session"],
      event: "start", initiatorClientId: "other-iphone",
    }, transport);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.headers["apns-push-type"]).toBe("liveactivity");
    expect(pushes[0]?.headers["apns-topic"]).toBe("moe.neri.hinatago.push-type.liveactivity");
    expect(pushes[0]?.url).toContain("api.sandbox.push.apple.com/3/device/abcdef123456");
    expect(pushes[0]?.payload.aps.event).toBe("start");
    expect(pushes[0]?.payload.aps.attributes).toMatchObject({
      sessionId: "session", shopCode: "demo", origin: "https://link.example",
    });
    expect((sqlite.query("SELECT last_seen_at FROM live_activity_start_tokens WHERE id='start'").get() as any)?.last_seen_at).not.toBeNull();
    expect(sqlite.query("SELECT id FROM live_activity_start_tokens WHERE id='gone'").get()).toBeNull();

    sqlite.run("UPDATE sessions SET ended_at='2026-10-08T02:00:00Z' WHERE id='session'");
    await pushSessionEvent(c, {
      shopId: "shop", playerId: "player", sessionIds: ["session"], event: "end",
    }, transport);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.payload.aps.event).toBe("end");
    expect(pushes[1]?.payload.aps["content-state"]).toMatchObject({
      phase: "ended", startedAtUnix: Date.parse("2026-10-08T01:00:00Z") / 1000,
      endedAtUnix: Date.parse("2026-10-08T02:00:00Z") / 1000,
    });
    expect((sqlite.query("SELECT session_id FROM live_activity_tokens WHERE id='activity'").get() as any)?.session_id).toBeNull();

    // The phone that entered starts its own activity, so it is not pushed one at once. When it
    // shows none for the visit after the grace period, it is pushed a start like any phone.
    sqlite.run("UPDATE sessions SET ended_at=NULL, payment_status='unpaid' WHERE id='session'");
    sqlite.run("DELETE FROM live_activity_tokens");
    const later: Promise<unknown>[] = [];
    const options = { later: (work: Promise<unknown>) => { later.push(work); }, wait: async () => {} };
    await pushSessionEvent(c, {
      shopId: "shop", playerId: "player", sessionIds: ["session"], event: "start", initiatorClientId: "iphone",
    }, transport, options);
    expect(pushes).toHaveLength(2);
    await Promise.all(later.splice(0));
    expect(pushes).toHaveLength(3);
    expect(pushes[2]?.payload.aps.event).toBe("start");
    expect(pushes[2]?.url).toContain("/3/device/abcdef123456");

    // A phone that shows the visit itself, or a visit already over, is left alone.
    sqlite.run(`INSERT INTO live_activity_tokens VALUES ('own', 'abcdef999999', 'sandbox', 'moe.neri.hinatago',
      'session', 'shop', 'account', '2026-10-08T01:00:05Z', NULL, 'iphone')`);
    await pushSessionEvent(c, {
      shopId: "shop", playerId: "player", sessionIds: ["session"], event: "start", initiatorClientId: "iphone",
    }, transport, options);
    await Promise.all(later.splice(0));
    sqlite.run("DELETE FROM live_activity_tokens");
    sqlite.run("UPDATE sessions SET payment_status='paid', ended_at='2026-10-08T02:00:00Z' WHERE id='session'");
    await pushSessionEvent(c, {
      shopId: "shop", playerId: "player", sessionIds: ["session"], event: "start", initiatorClientId: "iphone",
    }, transport, options);
    await Promise.all(later.splice(0));
    expect(pushes).toHaveLength(3);
    sqlite.close();
  });
});
