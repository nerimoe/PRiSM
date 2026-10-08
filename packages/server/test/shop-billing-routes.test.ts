import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { attachUser } from "../src/middleware/auth.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { shopRouter } from "../src/routes/shops/index.js";
import { billingSetupStatements } from "../src/routes/platform/shops.js";
import { sha256, sha256Hex } from "../src/crypto.js";

class InMemoryD1Database implements D1DatabaseLike {
  constructor(private readonly db: Database) {}

  prepare(sql: string) {
    const db = this.db;
    return {
      bind(...values: SqlValue[]) {
        return {
          async first<T = unknown>() {
            return (db.query(sql).get(...values) as T | null) ?? null;
          },
          async all<T = unknown>() {
            return {
              results: db.query(sql).all(...values) as T[],
            };
          },
          async run() {
            db.run(sql, values);
            return { success: true };
          },
        };
      },
    };
  }

  async batch(statements: readonly D1BoundStatementLike[]) {
    for (const statement of statements) {
      await statement.run();
    }
    return [];
  }
}

function createTestContext(): { db: D1DatabaseLike; sqlite: Database; env: Env } {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = OFF;");
  for (const statement of sqliteSchema) {
    sqlite.run(statement);
  }

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'user',
      banned_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS auth_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT,
      UNIQUE(provider, provider_subject),
      UNIQUE(user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 80,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      public_id TEXT,
      hero_data TEXT,
      hero_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS shop_billing_settings (
      shop_id TEXT PRIMARY KEY REFERENCES shops(id),
      billing_enabled INTEGER NOT NULL DEFAULT 0,
      auto_register INTEGER NOT NULL DEFAULT 0,
      identity_binding_required INTEGER NOT NULL DEFAULT 1,
      checkin_geo INTEGER NOT NULL DEFAULT 0,
      checkout_geo INTEGER NOT NULL DEFAULT 0,
      machine_geo INTEGER NOT NULL DEFAULT 0,
      entry_pricing_ids_json TEXT NOT NULL DEFAULT '[]',
      bot_contact TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS shop_members (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_staff_accounts (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      staff_id TEXT NOT NULL,
      PRIMARY KEY(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_player_accounts (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      player_id TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop_platform_bindings (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, provider, subject),
      UNIQUE(shop_id, user_id, provider)
    );
    CREATE TABLE IF NOT EXISTS platform_binding_codes (
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS machines (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      public_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hinata_url TEXT NOT NULL DEFAULT '',
      hinata_password TEXT,
      ha_binding_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL DEFAULT 'machine' CHECK(kind IN ('machine','door')),
      ttlock_lock_id INTEGER,
      coin_key INTEGER NOT NULL DEFAULT 1,
      coin_after_swipe INTEGER NOT NULL DEFAULT 0 CHECK(coin_after_swipe IN (0,1)),
      mahjong_config_json TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(shop_id,id),
      UNIQUE(shop_id,public_id)
    );
  `);

  const db = new InMemoryD1Database(sqlite);
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://prism.test",
    EXTRA_ALLOWED_ORIGINS: "https://admin.prism.test,https://player.prism.test",
    SESSION_SECRET: "secret-key",
  };

  return { db, sqlite, env };
}

describe("Direct Multi-Tenant Shop Billing Routes Suite", () => {
  beforeEach(() => {
    clearShopDependenciesCache();
  });

  async function setupShopFixture(db: D1DatabaseLike, sqlite: Database) {
    const shopId = "shop_uuid_shanghai";
    const publicId = "shanghai-hub";
    const staffUserId = "user_staff_1";
    const staffSessionToken = "staff-session-token-xyz";
    const botToken = "bot_token_secret_123";

    // 1. Insert shop and staff user
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [staffUserId],
    );
    sqlite.run(
      "INSERT INTO auth_identities (id, user_id, provider, provider_subject, display_name) VALUES ('ident_1', ?, 'local', 'staff1', 'Staff Alice')",
      [staffUserId],
    );
    const tokenHash = await sha256(staffSessionToken);
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES ('sess_1', ?, ?, datetime('now', '+7 days'))",
      [staffUserId, tokenHash],
    );

    sqlite.run(
      "INSERT INTO shops (id, public_id, name, latitude, longitude, radius_meters, created_by) VALUES (?, ?, ?, 31.23, 121.47, 100, ?)",
      [shopId, publicId, "Shanghai Hub", staffUserId],
    );
    sqlite.run(
      "INSERT INTO shop_members (id, shop_id, user_id, role) VALUES ('sm_1', ?, ?, 'owner')",
      [shopId, staffUserId],
    );

    // 2. Setup standard billing definitions & pricing
    const { statements } = billingSetupStatements(db, shopId, {
      paidName: "充值余额",
      freeName: "赠送余额",
      hourlyPrice: 3000,
      graceMinutes: 5,
      dailyCap: 18000,
      botContact: "bot-contact",
      autoRegister: true,
    });
    await db.batch(statements);

    // 3. Enable cashier and bypass identity binding for tests
    sqlite.run(
      "UPDATE shop_billing_settings SET identity_binding_required = 0, checkin_geo = 0, checkout_geo = 0, machine_geo = 0 WHERE shop_id = ?",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO app_settings (shop_id, key, value_json, updated_at) VALUES (?, 'cashier.settings', '{\"enabled\":true}', CURRENT_TIMESTAMP)",
      [shopId],
    );

    // 4. Register bot integration token
    const botTokenHash = await sha256Hex(botToken);
    sqlite.run(
      "INSERT INTO api_tokens (shop_id, id, label, role, token_prefix, token_hash, status, created_at) VALUES (?, 'tok_1', 'bot', 'integration', 'integration', ?, 'active', CURRENT_TIMESTAMP)",
      [shopId, botTokenHash],
    );

    return {
      shopId,
      publicId,
      staffUserId,
      staffSessionToken,
      botToken,
    };
  }

  function createTestApp() {
    const app = new Hono<AppBindings>();
    app.use("*", attachUser);
    app.route("/api/v1/shops/:shopCode", shopRouter);
    return app;
  }

  it("returns a grouped on-site player and real billing inputs for the browser; unauthenticated users are denied", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    sqlite.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?, 'on-site-player', '在店玩家示例', 'active', CURRENT_TIMESTAMP)",
      [shopId],
    );
    sqlite.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,status,payment_status,pricing_config_ids_json) VALUES (?, 'active-visit', 'on-site-player', '2026-10-02T02:08:00Z', 'active', 'unpaid', '[]')",
      [shopId],
    );
    const url = `https://prism.test/api/v1/shops/${publicId}/staff/live-players`;
    const anonymous = await app.fetch(new Request(url), env);
    expect([401, 403]).toContain(anonymous.status);
    const response = await app.fetch(new Request(url, {
      headers: { authorization: `Bearer ${staffSessionToken}` },
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      players: Array<{
        playerId: string; displayName: string; sessions: Array<{
          id: string; status: string; pricingCharges: unknown[]; pricingSegments: unknown[];
        }>; estimatedTotal: number | null;
      }>;
      billingSnapshot: { version: number; players: Array<{ playerId: string }> };
    };
    expect(body.players).toHaveLength(1);
    expect(body.players[0]).toMatchObject({
      playerId: "on-site-player", displayName: "在店玩家示例",
      estimatedTotal: null,
    });
    expect(body.players[0]?.sessions).toEqual([expect.objectContaining({
      id: "active-visit", status: "active", pricingCharges: [], pricingSegments: [],
    })]);
    expect(body.billingSnapshot.version).toBe(1);
    expect(body.billingSnapshot.players.map((player) => player.playerId)).toContain("on-site-player");
    sqlite.close();
  });

  it("keeps pre-fork shop data transfer owner-only and fails closed without rate limiting", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const exportUrl=`https://prism.test/api/v1/shops/${publicId}/data/export`;
    const previewUrl=`https://prism.test/api/v1/shops/${publicId}/data/import/preview`;

    const anonymous=await app.fetch(new Request(exportUrl),env);
    expect(anonymous.status).toBe(401);
    const anonymousPreview=await app.fetch(new Request(previewUrl,{
      method:"POST",headers:{"content-type":"application/json"},body:"{}",
    }),env);
    expect(anonymousPreview.status).toBe(401);

    const strangerToken="stranger-transfer-session";
    const strangerId="user_data_stranger";
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",[strangerId]);
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('stranger-session',?,?,?)",[
      strangerId,await sha256(strangerToken),new Date(Date.now()+86_400_000).toISOString(),
    ]);
    const stranger=await app.fetch(new Request(exportUrl,{
      headers:{authorization:`Bearer ${strangerToken}`},
    }),env);
    expect(stranger.status).toBe(403);

    // A legitimate owner is still blocked if Cloudflare's distributed limiter is absent.
    // The endpoint must not silently fall back to unbounded import/export operations.
    const owner=await app.fetch(new Request(exportUrl,{
      headers:{authorization:`Bearer ${staffSessionToken}`},
    }),env);
    expect(owner.status).toBe(503);
    expect((await owner.json() as {error:{code:string}}).error.code).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(sqlite.query("SELECT id FROM shops WHERE id=?").get(shopId)).not.toBeNull();
  });

  it("handles player session start, checkout preview, checkout confirm, and history", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    // Create an active player
    const playerId = "player_alice";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Alice', 'active', CURRENT_TIMESTAMP)",
      [shopId, playerId],
    );
    // Grant balance to Alice so checkout succeeds
    sqlite.run(
      "INSERT INTO asset_holdings (shop_id, id, player_id, asset_type, asset_code, quantity) VALUES (?, 'hold_1', ?, 'currency', 'paid', 100000)",
      [shopId, playerId],
    );

    // Create Alice's user account and session
    const aliceUserId = "user_alice";
    const aliceToken = "session_token_alice";
    const aliceTokenHash = await sha256(aliceToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [aliceUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_alice', ?, ?, ?, CURRENT_TIMESTAMP)",
      [aliceUserId, aliceTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [shopId, aliceUserId, playerId],
    );

    const aliceHeaders = {
      Authorization: `Bearer ${aliceToken}`,
      "Content-Type": "application/json",
    };

    // 1. Player session start
    const startRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/session/start`, {
        method: "POST",
        headers: aliceHeaders,
        body: JSON.stringify({ label: "play" }),
      }),
      env,
    );
    expect(startRes.status).toBe(200);
    const startData = (await startRes.json()) as any;
    expect(startData.session).toBeDefined();
    expect(startData.session.playerId).toBe(playerId);
    expect(startData.session.status).toBe("active");
    const sessionId = startData.session.id;

    // 2. Player summary / active session verification via GET /player/me
    const meRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: aliceHeaders,
      }),
      env,
    );
    expect(meRes.status).toBe(200);
    const meData = (await meRes.json()) as any;
    expect(meData.activeSession).toBeDefined();
    expect(meData.activeSession.id).toBe(sessionId);

    // 3. Checkout Preview
    const previewRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/checkout/preview`, {
        method: "POST",
        headers: aliceHeaders,
      }),
      env,
    );
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as any;
    expect(previewData.settlementPreview).toBeDefined();
    expect(previewData.sessionPreviews).toBeDefined();
    expect(previewData.sessionPreviews.length).toBeGreaterThanOrEqual(1);

    // 4. Checkout Confirm
    const confirmRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/checkout/confirm`, {
        method: "POST",
        headers: aliceHeaders,
      }),
      env,
    );
    expect(confirmRes.status).toBe(200);
    const confirmData = (await confirmRes.json()) as any;
    expect(confirmData.playerSettlement).toBeDefined();
    expect(confirmData.settlements).toBeDefined();
    expect(confirmData.settlements.length).toBeGreaterThanOrEqual(1);

    // 5. Checkout history
    const historyRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/checkouts/history`, {
        headers: aliceHeaders,
      }),
      env,
    );
    expect(historyRes.status).toBe(200);
    const historyData = (await historyRes.json()) as any;
    expect(historyData.records).toBeDefined();
    expect(historyData.records.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces authentication and prevents unprivileged X-PRiSM-Player-Id impersonation", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const victimPlayerId = "player_victim";
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Victim', 'active', CURRENT_TIMESTAMP)",
      [shopId, victimPlayerId],
    );

    // 1. Unauthenticated request with X-PRiSM-Player-Id must be rejected with 401
    const unauthRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: { "X-PRiSM-Player-Id": victimPlayerId },
      }),
      env,
    );
    expect(unauthRes.status).toBe(401);

    // 2. Regular non-staff user cannot spoof X-PRiSM-Player-Id (must be rejected with 403)
    const malloryUserId = "user_mallory";
    const malloryToken = "token_mallory";
    const malloryTokenHash = await sha256(malloryToken);
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();
    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [malloryUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_mallory', ?, ?, ?, CURRENT_TIMESTAMP)",
      [malloryUserId, malloryTokenHash, futureExpiry],
    );

    const spoofRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: {
          Authorization: `Bearer ${malloryToken}`,
          "X-PRiSM-Player-Id": victimPlayerId,
        },
      }),
      env,
    );
    expect(spoofRes.status).toBe(403);

    // 3. Authorized staff member CAN act on behalf of player with X-PRiSM-Player-Id
    const staffRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/me`, {
        headers: {
          Authorization: `Bearer ${staffSessionToken}`,
          "X-PRiSM-Player-Id": victimPlayerId,
        },
      }),
      env,
    );
    expect(staffRes.status).toBe(200);
    const staffData = (await staffRes.json()) as any;
    expect(staffData.player.id).toBe(victimPlayerId);
  });

  it("handles cashier card registration, lookup, entry session, preview, and external settlement", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const authHeaders = {
      Authorization: `Bearer ${staffSessionToken}`,
      "Content-Type": "application/json",
    };

    // 1. Register Cashier Card
    const regRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/register`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          card: {
            kind: "type-a",
            uid: "11223344",
          },
          displayName: "Cashier Player Bob",
        }),
      }),
      env,
    );
    expect(regRes.status).toBe(201);
    const regData = (await regRes.json()) as any;
    expect(regData.profile).toBeDefined();
    expect(regData.profile.displayName).toBe("Cashier Player Bob");
    expect(regData.profile.uid).toBe("11223344");
    const cashierPlayerId = regData.profile.id;

    // 2. Lookup Cashier Card via POST /lookup
    const lookupRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/lookup`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          kind: "type-a",
          uid: "11223344",
        }),
      }),
      env,
    );
    expect(lookupRes.status).toBe(200);
    const lookupData = (await lookupRes.json()) as any;
    expect(lookupData.profile).toBeDefined();
    expect(lookupData.profile.id).toBe(cashierPlayerId);

    // 3. Start Entry Session via Cashier
    const entryRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/profiles/${cashierPlayerId}/entry`, {
        method: "POST",
        headers: authHeaders,
      }),
      env,
    );
    expect(entryRes.status).toBe(200);
    const entryData = (await entryRes.json()) as any;
    expect(entryData.session).toBeDefined();
    expect(entryData.session.playerId).toBe(cashierPlayerId);
    const cashierSessionId = entryData.session.id;

    // 4. Cashier Checkout Preview
    const previewRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/profiles/${cashierPlayerId}/checkout/preview`, {
        method: "POST",
        headers: authHeaders,
      }),
      env,
    );
    expect(previewRes.status).toBe(200);
    const previewData = (await previewRes.json()) as any;
    expect(previewData.settlementPreview).toBeDefined();
    expect(previewData.sessionPreviews).toBeDefined();

    // 5. Cashier Checkout Confirm with external payment (wechat)
    const settleRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/cashier/profiles/${cashierPlayerId}/checkout/confirm`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          method: "wechat",
          previewedAt: previewData.settlementPreview.previewedAt,
          expectedTotal: 0,
          sessionIds: [cashierSessionId],
        }),
      }),
      env,
    );
    expect(settleRes.status).toBe(200);
    const settleData = (await settleRes.json()) as any;
    expect(settleData.playerSettlement).toBeDefined();
    expect(settleData.payment).toBeDefined();
    expect(settleData.payment.method).toBe("wechat");
    expect(settleData.payment.collected).toBe(true);
  });

  it("handles staff queries: players list, player assets, wallet adjustment, and reports summary", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const authHeaders = {
      Authorization: `Bearer ${staffSessionToken}`,
    };

    // Create players
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, 'p_staff_test', 'Staff Test Player', 'active', CURRENT_TIMESTAMP)",
      [shopId],
    );

    // 1. Staff players list
    const playersRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/players`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(playersRes.status).toBe(200);
    const playersData = (await playersRes.json()) as any;
    expect(playersData.players).toBeDefined();
    expect(playersData.players.length).toBeGreaterThanOrEqual(1);
    expect(playersData.players.some((p: any) => p.id === "p_staff_test")).toBe(true);

    // 2. Staff player assets
    const assetsRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/players/p_staff_test/assets`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(assetsRes.status).toBe(200);
    const assetsData = (await assetsRes.json()) as any;
    expect(assetsData.holdings).toBeDefined();
    expect(assetsData.ledgerEntries).toBeDefined();

    // 3. Staff wallet adjustment
    const adjustRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/players/p_staff_test/wallet/adjustment`, {
        method: "POST",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: 5000,
          reason: "staff bonus",
        }),
      }),
      env,
    );
    expect(adjustRes.status).toBe(200);

    // 4. Staff reports summary
    const reportsRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/staff/reports/summary`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(reportsRes.status).toBe(200);
    const reportsData = (await reportsRes.json()) as any;
    expect(reportsData.summary).toBeDefined();
    expect(reportsData.summary.from).toBeDefined();
    expect(reportsData.summary.to).toBeDefined();
  });

  it("handles pricing and asset definition listings", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const authHeaders = {
      Authorization: `Bearer ${staffSessionToken}`,
    };

    // 1. Pricing configs
    const pricingRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/pricing`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(pricingRes.status).toBe(200);
    const pricingData = (await pricingRes.json()) as any;
    expect(pricingData.pricingConfigs).toBeDefined();
    expect(pricingData.pricingConfigs.length).toBeGreaterThanOrEqual(1);

    // 2. Asset definitions
    const assetsRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/assets`, {
        headers: authHeaders,
      }),
      env,
    );
    expect(assetsRes.status).toBe(200);
    const assetsData = (await assetsRes.json()) as any;
    expect(assetsData.assetDefinitions).toBeDefined();
    expect(assetsData.assetDefinitions.length).toBeGreaterThanOrEqual(2);
  });

  it("handles bot integration player resolution and wallet query", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, botToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    const botHeaders = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    };

    // 1. Resolve or register player by bot identity
    const botRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/register`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({
          provider: "qq",
          subject: "88889999",
          displayName: "QQ Player",
        }),
      }),
      env,
    );
    expect(botRes.status).toBe(200);
    const botData = (await botRes.json()) as any;
    expect(botData.player).toBeDefined();
    expect(botData.player.displayName).toBe("QQ Player");

    // 2. Query wallet by identity
    const walletRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/players/by-identity/wallet`, {
        method: "POST",
        headers: botHeaders,
        body: JSON.stringify({
          provider: "qq",
          subject: "88889999",
        }),
      }),
      env,
    );
    expect(walletRes.status).toBe(200);
    const walletData = (await walletRes.json()) as any;
    expect(walletData.wallet).toBeDefined();
    expect(Array.isArray(walletData.wallet)).toBe(true);
  });

  it("handles platform-binding generation and confirmation via staff and integration", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken, botToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();

    // 1. Create a user and player account
    const bobUserId = "user_bob";
    const bobToken = "token_bob";
    const bobTokenHash = await sha256(bobToken);
    const bobPlayerId = "player_bob";
    const futureExpiry = new Date(Date.now() + 86400000 * 7).toISOString();

    sqlite.run(
      "INSERT INTO users (id, role, created_at, updated_at) VALUES (?, 'user', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [bobUserId],
    );
    sqlite.run(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_bob', ?, ?, ?, CURRENT_TIMESTAMP)",
      [bobUserId, bobTokenHash, futureExpiry],
    );
    sqlite.run(
      "INSERT INTO players (shop_id, id, display_name, status, created_at) VALUES (?, ?, 'Bob', 'active', CURRENT_TIMESTAMP)",
      [shopId, bobPlayerId],
    );
    sqlite.run(
      "INSERT INTO shop_player_accounts (shop_id, user_id, player_id, verified_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      [shopId, bobUserId, bobPlayerId],
    );

    // 2. Bob requests a binding code via POST /platform-binding
    const codeRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/platform-binding`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bobToken}`,
        },
      }),
      env,
    );
    expect(codeRes.status).toBe(200);
    const codeData = (await codeRes.json()) as any;
    expect(codeData.code).toBeDefined();
    expect(codeData.code.length).toBe(8);
    const bindingCode = codeData.code;

    // 3. Confirm platform binding via bot integration
    const confirmRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/integration/platform-binding/confirm`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: bindingCode,
          provider: "qq",
          subject: "99887766",
        }),
      }),
      env,
    );
    expect(confirmRes.status).toBe(200);
    const confirmData = (await confirmRes.json()) as any;
    expect(confirmData.playerId).toBe(bobPlayerId);
    expect(confirmData.provider).toBe("qq");
    expect(confirmData.subject).toBe("99887766");

    // 4. Verify binding was saved in shop_platform_bindings
    const bindingRow = sqlite.query(
      "SELECT provider, subject FROM shop_platform_bindings WHERE shop_id = ? AND user_id = ?",
    ).get(shopId, bobUserId) as { provider: string; subject: string } | null;
    expect(bindingRow).toBeDefined();
    expect(bindingRow?.provider).toBe("qq");
    expect(bindingRow?.subject).toBe("99887766");
  });

  it("preserves independent geo gates when updating shop settings", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, shopId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const config = sqlite.query<{ entry_pricing_ids_json: string }, [string]>(
      "SELECT entry_pricing_ids_json FROM shop_billing_settings WHERE shop_id=?",
    ).get(shopId);
    const response = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/settings`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${staffSessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          billingEnabled: true,
          cashierEnabled: true,
          autoRegister: true,
          identityBindingRequired: false,
          checkinGeo: true,
          checkoutGeo: false,
          machineGeo: true,
          entryPricingIds: JSON.parse(config!.entry_pricing_ids_json),
          botContact: "owner@example.test",
        }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const flags = sqlite.query<{ checkin_geo: number; checkout_geo: number; machine_geo: number }, [string]>(
      "SELECT checkin_geo,checkout_geo,machine_geo FROM shop_billing_settings WHERE shop_id=?",
    ).get(shopId);
    expect(flags?.checkin_geo).toBe(1);
    expect(flags?.checkout_geo).toBe(0);
    expect(flags?.machine_geo).toBe(1);
  });

  it("rejects invalid checkout report ranges and archive filters with stable error codes", async () => {
    const { db, sqlite, env } = createTestContext();
    const { publicId, staffSessionToken } = await setupShopFixture(db, sqlite);
    const app = createTestApp();
    const base = `https://prism.test/api/v1/shops/${publicId}/staff/reports/checkouts`;
    const headers = { Authorization: `Bearer ${staffSessionToken}` };
    const invalidRange = await app.fetch(
      new Request(`${base}?from=invalid&to=2026-10-01T00:00:00.000Z`, { headers }), env,
    );
    expect(invalidRange.status).toBe(400);
    const badRange = await invalidRange.json() as { error: { code: string } };
    expect(badRange.error.code).toBe("INVALID_REPORT_RANGE");
    const invalidFilter = await app.fetch(
      new Request(`${base}?from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&archive=unknown`, { headers }), env,
    );
    expect(invalidFilter.status).toBe(400);
    const badFilter = await invalidFilter.json() as { error: { code: string } };
    expect(badFilter.error.code).toBe("INVALID_REPORT_FILTER");
  });
});
