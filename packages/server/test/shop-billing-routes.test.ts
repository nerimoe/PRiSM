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

    // 1. Player session start
    const startRes = await app.fetch(
      new Request(`https://prism.test/api/v1/shops/${publicId}/player/session/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PRiSM-Player-Id": playerId,
        },
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
        headers: { "X-PRiSM-Player-Id": playerId },
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
        headers: {
          "Content-Type": "application/json",
          "X-PRiSM-Player-Id": playerId,
        },
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
        headers: {
          "Content-Type": "application/json",
          "X-PRiSM-Player-Id": playerId,
        },
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
        headers: { "X-PRiSM-Player-Id": playerId },
      }),
      env,
    );
    expect(historyRes.status).toBe(200);
    const historyData = (await historyRes.json()) as any;
    expect(historyData.records).toBeDefined();
    expect(historyData.records.length).toBeGreaterThanOrEqual(1);
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
});
