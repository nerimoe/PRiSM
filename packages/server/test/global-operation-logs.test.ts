import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import type { Env } from "../src/bindings.js";
import { sha256, sha256Hex } from "../src/crypto.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";

const migrationsDir = resolve(import.meta.dir, "../../../migrations");

function createTestEnv() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = OFF");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    for (const statement of splitD1MigrationStatements(sql)) {
      sqlite.run(statement);
    }
  }
  const db = createD1DatabaseFromSqlite(sqlite);
  const env = {
    DB: db,
    SESSION_SECRET: "test-session-secret",
    URL_ENCRYPTION_KEY: "test-encryption-key",
    APP_ORIGIN: "https://prism.test",
  } as unknown as Env;
  return { sqlite, db, env, app: createApp() };
}

async function createSessionCookie(sqlite: Database, userId: string) {
  const token = `session-${userId}-${crypto.randomUUID()}`;
  sqlite.run(
    "INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)",
    [crypto.randomUUID(), userId, await sha256(token), new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString()],
  );
  return `arcadelink_session=${token}`;
}

async function seedShop(sqlite: Database) {
  const now = new Date("2026-11-20T06:00:00.000Z").toISOString();
  const hash = "test-hash";
  const salt = "test-salt";
  for (const [id, username, displayName] of [
    ["owner-1", "owner", "店主"],
    ["staff-u1", "cashier1", "收银员A"],
    ["player-u1", "p1user", "玩家小明"],
    ["outsider-1", "out", "局外人"],
  ] as const) {
    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES (?,'user',?,?)", [id, now, now]);
    sqlite.run(
      "INSERT INTO auth_identities(id, user_id, provider, provider_subject, username, display_name, created_at, updated_at) VALUES (?,?,'local',?,?,?,?,?)",
      [`id-${id}`, id, username, username, displayName, now, now],
    );
  }
  sqlite.run(
    "INSERT INTO shops(id, public_id, name, latitude, longitude, radius_meters, created_by, created_at, updated_at) VALUES ('shop-1','shop-pub','测试店铺',31.23,121.47,80,'owner-1',?,?)",
    [now, now],
  );
  sqlite.run(
    "INSERT INTO shop_members(id, shop_id, user_id, role, created_at) VALUES ('sm-1','shop-1','owner-1','owner',?),('sm-2','shop-1','staff-u1','manager',?)",
    [now, now],
  );
  sqlite.run(
    "INSERT INTO shop_billing_settings(shop_id, auto_register, identity_binding_required, checkin_geo, checkout_geo, machine_geo, bot_contact) VALUES ('shop-1',1,0,0,0,0,'')",
  );
  sqlite.run(
    "INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES ('shop-1','store.profile',?,?)",
    [JSON.stringify({ timeZone: "Asia/Shanghai" }), now],
  );
  sqlite.run(
    "INSERT INTO app_settings(shop_id, key, value_json, updated_at) VALUES ('shop-1','cashier.settings',?,?)",
    [JSON.stringify({ enabled: true, resourceId: null }), now],
  );
  sqlite.run(
    "INSERT INTO asset_definitions(shop_id, type, code, name, stackable, status) VALUES ('shop-1','currency','paid','充值余额',1,'active'),('shop-1','currency','free','赠送余额',1,'active')",
  );
  sqlite.run(
    "INSERT INTO players(shop_id, id, display_name, status, created_at) VALUES ('shop-1','player-1','小明','active',?)",
    [now],
  );
  sqlite.run(
    "INSERT INTO player_identities(shop_id, player_id, provider, subject, created_at) VALUES ('shop-1','player-1','web-account','player-u1',?)",
    [now],
  );
  sqlite.run(
    "INSERT INTO pricing_configs(shop_id, id, kind, name, enabled, status, provider_json, created_at, updated_at) VALUES ('shop-1','plan-1','charge.fixed','入场费',1,'active',?,?,?)",
    [JSON.stringify({ id: "fixed-1", label: "入场费", amount: 2000 }), now, now],
  );
  sqlite.run(
    "INSERT INTO machines(shop_id, id, public_id, name, enabled, kind, hinata_url_encrypted) VALUES ('shop-1','res-1','res-pub','舞萌 1 号',1,'machine','')",
  );
  sqlite.run(
    "INSERT INTO sessions(shop_id, id, player_id, pricing_config_ids_json, label, status, payment_status, started_at, metadata_json) VALUES ('shop-1','sess-1','player-1',?,'入场费','active','unpaid',?,'{}')",
    [JSON.stringify(["plan-1"]), new Date(Date.now() - 10 * 60_000).toISOString()],
  );
  // Seed one device event tied to res-1
  sqlite.run(
    "INSERT INTO device_events(shop_id, id, device_id, capability, kind, name, origin, player_id, payload_json, occurred_at) VALUES ('shop-1','ev-res-1','res-1','coin','signal','coin','platform','player-1','{}',?)",
    [new Date("2026-11-20T05:00:00.000Z").toISOString()],
  );
  // Seed a legacy staff token for /staff/events check
  const rawStaffToken = "prism_admin_test_token";
  sqlite.run(
    "INSERT INTO staff_users(shop_id, id, username, display_name, password_hash, password_salt, role, status, created_at, updated_at) VALUES ('shop-1','staff-1','cashier1','收银员A',?,?,'manager','active',?,?)",
    [hash, salt, now, now],
  );
  sqlite.run(
    "INSERT INTO shop_staff_accounts(shop_id, user_id, staff_id) VALUES ('shop-1','staff-u1','staff-1')",
  );
  sqlite.run(
    "INSERT INTO admin_sessions(shop_id, id, staff_user_id, token_hash, created_at, expires_at, last_used_at) VALUES ('shop-1','as-1','staff-1',?,?,?,?)",
    [await sha256Hex(rawStaffToken), now, new Date(Date.now() + 3600_000).toISOString(), now],
  );
  return { rawStaffToken };
}

async function jsonData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data?: T } & T;
  return (body.data ?? body) as T;
}

describe("shop-wide & non-resource operation logs", () => {
  it("persists failed checkout attempts, staff/cashier operations, and queries them via merchant & staff APIs", async () => {
    const { sqlite, env, app } = createTestEnv();
    const { rawStaffToken } = await seedShop(sqlite);
    const ownerCookie = await createSessionCookie(sqlite, "owner-1");
    const staffCookie = await createSessionCookie(sqlite, "staff-u1");
    const playerCookie = await createSessionCookie(sqlite, "player-u1");
    const outsiderCookie = await createSessionCookie(sqlite, "outsider-1");

    // 1. Player attempts checkout with insufficient balance -> persisted as checkout.refused (device_id = null)
    const failedCheckout = await app.fetch(
      new Request("https://prism.test/api/v1/shops/shop-pub/player/checkout/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: playerCookie },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      }),
      env,
    );
    expect(failedCheckout.status).toBe(409);

    // 2. Enable checkout geo and attempt checkout inside shop -> persisted as checkout.refused (LOCATION_STILL_INSIDE)
    sqlite.run("UPDATE shop_billing_settings SET checkout_geo = 1 WHERE shop_id = 'shop-1'");
    const geoRefused = await app.fetch(
      new Request("https://prism.test/api/v1/shops/shop-pub/player/checkout/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: playerCookie },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          location: { lat: 31.23, lng: 121.47, accuracy: 10 },
        }),
      }),
      env,
    );
    expect(geoRefused.status).toBe(403);

    // 3. Cashier registers a card profile & tries entry without cashier resource -> persisted with staff actor
    const cashierRegister = await app.fetch(
      new Request("https://prism.test/api/v1/shops/shop-pub/cashier/register", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({
          card: { kind: "felica", uid: "0123456789ABCDEF" },
          displayName: "前台客人",
        }),
      }),
      env,
    );
    expect(cashierRegister.status).toBe(201);
    const registered = await jsonData<{ profile: { id: string } }>(cashierRegister);

    const cashierEntryFail = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/shop-pub/cashier/profiles/${registered.profile.id}/entry`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ownerCookie },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(cashierEntryFail.status).toBe(409);

    // 4. Staff tops up player wallet then checks out player -> wallet.adjusted + checkout.settled with staffId
    const topup = await app.fetch(
      new Request("https://prism.test/api/v1/shops/shop-pub/staff/players/player-1/wallet/adjustment", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: staffCookie },
        body: JSON.stringify({ operationId: crypto.randomUUID(), amount: 50, reason: "测试充值" }),
      }),
      env,
    );
    expect(topup.status).toBe(200);

    const settledCheckout = await app.fetch(
      new Request("https://prism.test/api/v1/shops/shop-pub/staff/players/player-1/checkout/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: staffCookie },
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
      }),
      env,
    );
    expect(settledCheckout.status).toBe(200);

    // 5. Query non-resource operations via /api/v1/merchant/events
    const nonResRes = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/events?shopId=shop-1&scope=non_resource", {
        headers: { cookie: ownerCookie },
      }),
      env,
    );
    expect(nonResRes.status).toBe(200);
    type EventsResponse = {
      nextCursor: string | null;
      events: Array<{
        id: string;
        name: string;
        device: { id: string; name: string | null } | null;
        player: { id: string; name: string | null } | null;
        staff: { id: string; name: string | null } | null;
        via: { channel: string } | null;
        at: string;
        payload: Record<string, unknown>;
      }>;
    };
    const nonResBody = await jsonData<EventsResponse>(nonResRes);

    expect(nonResBody.events.every((e) => e.device === null)).toBe(true);
    expect(nonResBody.events.map((e) => e.name)).toEqual([
      "checkout.settled",
      "wallet.adjusted",
      "entry.refused",
      "player.changed",
      "checkout.refused",
      "checkout.refused",
    ]);
    // Staff actor resolved on staff checkout & wallet adjustment
    expect(nonResBody.events[0]!.staff).toEqual({ id: "staff-1", name: "收银员A" });
    expect(nonResBody.events[0]!.player).toEqual({ id: "player-1", name: "小明" });
    // Timezone conversion applied (Asia/Shanghai -> +08:00)
    expect(nonResBody.events[0]!.at).toMatch(/\+08:00$/);
    // Refusal error codes preserved
    expect(nonResBody.events[4]!.payload.code).toBe("LOCATION_STILL_INSIDE");
    expect(nonResBody.events[5]!.payload.code).toBe("INSUFFICIENT_BALANCE");

    // 6. Query checkout category filter & pagination
    const checkoutOnly = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/events?shopId=shop-1&category=checkout&limit=2", {
        headers: { cookie: ownerCookie },
      }),
      env,
    );
    expect(checkoutOnly.status).toBe(200);
    const page1 = await jsonData<EventsResponse>(checkoutOnly);
    expect(page1.events.map((e) => e.name)).toEqual(["checkout.settled", "checkout.refused"]);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await app.fetch(
      new Request(
        `https://prism.test/api/v1/merchant/events?shopId=shop-1&category=checkout&limit=2&before=${encodeURIComponent(page1.nextCursor!)}`,
        { headers: { cookie: ownerCookie } },
      ),
      env,
    );
    const page2 = await jsonData<EventsResponse>(page2Res);
    expect(page2.events.map((e) => e.name)).toEqual(["checkout.refused"]);
    expect(page2.nextCursor).toBeNull();

    // 7. Query scope=all and scope=resource and resourceId=res-1
    const allRes = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/events?shopId=shop-1&scope=all", {
        headers: { cookie: ownerCookie },
      }),
      env,
    );
    const allBody = await jsonData<EventsResponse>(allRes);
    expect(allBody.events.some((e) => e.device?.id === "res-1" && e.device.name === "舞萌 1 号")).toBe(true);
    expect(allBody.events.some((e) => e.device === null && e.name === "checkout.settled")).toBe(true);

    const resourceOnly = await jsonData<EventsResponse>(
      await app.fetch(
        new Request("https://prism.test/api/v1/merchant/events?shopId=shop-1&scope=resource", {
          headers: { cookie: ownerCookie },
        }),
        env,
      ),
    );
    expect(resourceOnly.events.map((e) => e.device?.id)).toEqual(["res-1"]);

    // 8. Staff token endpoint `/api/v1/shops/:shopCode/staff/events` works identically
    const staffEvents = await app.fetch(
      new Request("https://prism.test/api/v1/shops/shop-pub/staff/events?scope=non_resource&category=checkout", {
        headers: { authorization: `Bearer ${rawStaffToken}` },
      }),
      env,
    );
    expect(staffEvents.status).toBe(200);
    const staffBody = await jsonData<EventsResponse>(staffEvents);
    expect(staffBody.events.map((e) => e.name)).toEqual(["checkout.settled", "checkout.refused", "checkout.refused"]);

    // 9. Rejects invalid filter combinations and unauthorized users
    const invalidCombo = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/events?shopId=shop-1&scope=non_resource&resourceId=res-1", {
        headers: { cookie: ownerCookie },
      }),
      env,
    );
    expect(invalidCombo.status).toBe(400);

    const forbidden = await app.fetch(
      new Request("https://prism.test/api/v1/merchant/events?shopId=shop-1", {
        headers: { cookie: outsiderCookie },
      }),
      env,
    );
    expect(forbidden.status).toBe(403);

    sqlite.close();
  });
});
