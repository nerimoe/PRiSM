import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sqliteSchema } from "@prism/storage-sql";
import type { D1BoundStatementLike, D1DatabaseLike, SqlValue } from "@prism/adapter-d1";
import type { AppBindings, Env } from "../src/bindings.js";
import { attachUser } from "../src/middleware/auth.js";
import { authRouter } from "../src/routes/platform/auth.js";
import { passkeysRouter } from "../src/routes/platform/passkeys.js";
import { userRouter } from "../src/routes/platform/user.js";
import { createApp } from "../src/app.js";
import { shopsRouter } from "../src/routes/platform/shops.js";
import { healthRouter } from "../src/routes/system/health.js";
import { versionRouter } from "../src/routes/system/version.js";
import { serveWebAssets, isAssetEligiblePath } from "../src/routes/web-assets.js";

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
            const res = db.run(sql, values);
            return { success: true, meta: { changes: res.changes } };
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

function createTestEnvironment(): { db: D1DatabaseLike; sqlite: Database; env: Env; app: Hono<AppBindings> } {
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
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      purpose TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      aaguid TEXT,
      provider_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS shops (
      id TEXT PRIMARY KEY,
      public_id TEXT,
      name TEXT NOT NULL,
      hero_data TEXT,
      hero_hash TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 80,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS shop_members (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL REFERENCES shops(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL DEFAULT 'owner',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id, user_id)
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
    CREATE TABLE IF NOT EXISTS app_settings (
      shop_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, key)
    );
    CREATE TABLE IF NOT EXISTS api_tokens (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      role TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, id)
    );
    CREATE TABLE IF NOT EXISTS asset_definitions (
      shop_id TEXT NOT NULL,
      type TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      stackable INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (shop_id, type, code)
    );
    CREATE TABLE IF NOT EXISTS pricing_configs (
      shop_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      provider_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, id)
    );
    CREATE TABLE IF NOT EXISTS platform_binding_codes (
      shop_id TEXT NOT NULL,
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS shop_staff_accounts (
      shop_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      PRIMARY KEY (shop_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS machine_tickets (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_operations (
      id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS machine_login_events (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL
    );
  `);

  const db = new InMemoryD1Database(sqlite);
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://prism.test",
    PRISM_DEPLOY_REVISION: "rev-test-123",
  };

  const app = new Hono<AppBindings>();
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    return c.json({ error: { message: err.message } }, 500);
  });

  app.use("*", attachUser);

  app.route("/api/v1/auth", authRouter);
  app.route("/api/v1/user", userRouter);
  app.route("/api/v1", userRouter);
  app.route("/api/v1/shops", shopsRouter);
  app.route("/api/v1/merchant/shops", shopsRouter);
  app.route("/api/v1/health", healthRouter);
  app.route("/health", healthRouter);
  app.route("/api/v1/version", versionRouter);
  app.route("/version", versionRouter);

  return { db, sqlite, env, app };
}

describe("Platform & System Routes", () => {
  let env: Env;
  let app: Hono<AppBindings>;

  beforeEach(() => {
    const ctx = createTestEnvironment();
    env = ctx.env;
    app = ctx.app;
  });

  describe("System Routes: Health & Version", () => {
    it("GET /health returns healthy status and service name", async () => {
      const res = await app.request("https://prism.test/health", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean; service: string; status: string };
      expect(data.ok).toBe(true);
      expect(data.service).toBe("prism-api");
      expect(data.status).toBe("healthy");
      expect(res.headers.get("x-prism-revision")).toBe("rev-test-123");
    });

    it("GET /api/v1/health also returns healthy status", async () => {
      const res = await app.request("https://prism.test/api/v1/health", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json() as { ok: boolean };
      expect(data.ok).toBe(true);
    });

    it("GET /version and /api/v1/version return version info", async () => {
      const res1 = await app.request("https://prism.test/version", {}, env);
      expect(res1.status).toBe(200);
      const data1 = await res1.json() as { service: string; version: string; revision: string };
      expect(data1.service).toBe("prism-api");
      expect(data1.version).toBe("1.0.0");
      expect(data1.revision).toBe("rev-test-123");

      const res2 = await app.request("https://prism.test/api/v1/version", {}, env);
      expect(res2.status).toBe(200);
      const data2 = await res2.json() as { service: string };
      expect(data2.service).toBe("prism-api");
    });
  });

  describe("Platform Auth: Register, Login, Me, Logout", () => {
    it("registers a new user and sets session cookie", async () => {
      const registerRes = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "alice", displayName: "Alice Wonderland" }),
        },
        env,
      );

      expect(registerRes.status).toBe(201);
      const registerData = await registerRes.json() as { ok: boolean; user: { id: string; username: string; displayName: string } };
      expect(registerData.ok).toBe(true);
      expect(registerData.user.username).toBe("alice");
      expect(registerData.user.displayName).toBe("Alice Wonderland");

      const cookie = registerRes.headers.get("set-cookie");
      expect(cookie).toContain("arcadelink_session=");

      // Inspect me with the session cookie
      const meRes = await app.request(
        "https://prism.test/api/v1/user/me",
        { headers: { cookie: cookie! } },
        env,
      );
      expect(meRes.status).toBe(200);
      const meData = await meRes.json() as { user: { username: string; hasShops: boolean } };
      expect(meData.user.username).toBe("alice");
      expect(meData.user.hasShops).toBe(false);
    });

    it("rejects duplicate username registration with 409", async () => {
      await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "bob" }),
        },
        env,
      );

      const dupRes = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "bob" }),
        },
        env,
      );

      expect(dupRes.status).toBe(409);
    });

    it("logs in existing user and terminates session on logout", async () => {
      // Register first
      await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "charlie" }),
        },
        env,
      );

      // Login
      const loginRes = await app.request(
        "https://prism.test/api/v1/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "charlie" }),
        },
        env,
      );

      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers.get("set-cookie");
      expect(cookie).toContain("arcadelink_session=");

      // Logout
      const logoutRes = await app.request(
        "https://prism.test/api/v1/auth/logout",
        {
          method: "POST",
          headers: { cookie: cookie! },
        },
        env,
      );
      expect(logoutRes.status).toBe(200);

      // Verify session expired
      const meRes = await app.request(
        "https://prism.test/api/v1/user/me",
        { headers: { cookie: cookie! } },
        env,
      );
      expect(meRes.status).toBe(200);
      const meData = await meRes.json() as { user: null };
      expect(meData.user).toBeNull();
    });

    it("rejects login for unknown user with 401", async () => {
      const loginRes = await app.request(
        "https://prism.test/api/v1/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "unknown-user" }),
        },
        env,
      );
      expect(loginRes.status).toBe(401);
    });
  });

  describe("Platform Passkeys: Options & Challenges", () => {
    it("generates authentication options challenge", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/auth/passkey/options",
        {},
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as { challenge: string; rpId: string };
      expect(typeof data.challenge).toBe("string");
      expect(data.challenge.length).toBeGreaterThan(10);
      expect(data.rpId).toBe("prism.test");

      const cookie = res.headers.get("set-cookie");
      expect(cookie).toContain("arcadelink_passkey_challenge=");
    });

    it("requires user for registration options", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/auth/passkey/register/options",
        {},
        env,
      );
      expect(res.status).toBe(401);
    });

    it("generates registration options for authenticated user", async () => {
      const reg = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "dave" }),
        },
        env,
      );
      const sessionCookie = reg.headers.get("set-cookie")!;

      const res = await app.request(
        "https://prism.test/api/v1/auth/passkey/register/options",
        { headers: { cookie: sessionCookie } },
        env,
      );

      expect(res.status).toBe(200);
      const data = await res.json() as {
        challenge: string;
        rp: { id: string; name: string };
        user: { name: string; displayName: string };
      };
      expect(data.challenge).toBeDefined();
      expect(data.rp.name).toBe("PRiSM");
      expect(data.user.name).toBe("dave");
    });
  });

  describe("User Profile & Account", () => {
    it("GET /api/v1/account lists user identities and passkeys", async () => {
      const reg = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "eve", displayName: "Eve Tester" }),
        },
        env,
      );
      const sessionCookie = reg.headers.get("set-cookie")!;

      const res = await app.request(
        "https://prism.test/api/v1/account",
        { headers: { cookie: sessionCookie } },
        env,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as { identities: Array<{ username: string; displayName: string }>; passkeys: Array<unknown> };
      expect(data.identities).toHaveLength(1);
      expect(data.identities[0]!.username).toBe("eve");
      expect(data.identities[0]!.displayName).toBe("Eve Tester");
      expect(data.passkeys).toHaveLength(0);
    });
  });

  describe("Production app route contract", () => {
    it("serves the account overview instead of the user profile at /api/v1/account", async () => {
      // Unlike the lightweight router fixture, this uses the actual deployed
      // route ordering and { data } envelope, which previously hid the regression.
      const reg = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "route-account", displayName: "Account Route" }),
        },
        env,
      );
      expect(reg.status).toBe(201);
      const cookie = reg.headers.get("set-cookie")!;
      const productionApp = createApp();

      const accountResponse = await productionApp.request(
        "https://prism.test/api/v1/account",
        { headers: { cookie } },
        env,
      );
      expect(accountResponse.status).toBe(200);
      const account = await accountResponse.json() as {
        data?: { identities?: Array<{ username: string; displayName: string }>; passkeys?: unknown[]; user?: unknown };
      };
      expect(account.data?.identities).toHaveLength(1);
      expect(account.data?.identities?.[0]?.username).toBe("route-account");
      expect(account.data?.identities?.[0]?.displayName).toBe("Account Route");
      expect(account.data?.passkeys).toEqual([]);
      expect(account.data?.user).toBeUndefined();

      const meResponse = await productionApp.request(
        "https://prism.test/api/v1/me",
        { headers: { cookie } },
        env,
      );
      expect(meResponse.status).toBe(200);
      const me = await meResponse.json() as { data?: { user?: { username: string } } };
      expect(me.data?.user?.username).toBe("route-account");

      const unauthenticated = await productionApp.request(
        "https://prism.test/api/v1/account", {}, env,
      );
      expect(unauthenticated.status).toBe(401);
      const error = await unauthenticated.json() as { error?: { code: string } };
      expect(error.error?.code).toBe("AUTHENTICATION_REQUIRED");
    });
  });

  describe("Platform Shops: Creation, Listing, Updating, Deletion", () => {
    let ownerCookie: string;
    let otherCookie: string;

    beforeEach(async () => {
      const r1 = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "shop-owner" }),
        },
        env,
      );
      ownerCookie = r1.headers.get("set-cookie")!;

      const r2 = await app.request(
        "https://prism.test/api/v1/auth/register",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "other-user" }),
        },
        env,
      );
      otherCookie = r2.headers.get("set-cookie")!;
    });

    it("requires authentication to create a shop", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Arcade Central",
            latitude: 31.23,
            longitude: 121.47,
          }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });

    it("creates a shop with billing setup and bot integration token", async () => {
      const res = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: ownerCookie,
          },
          body: JSON.stringify({
            name: "Neon Arcade",
            latitude: 31.2304,
            longitude: 121.4737,
            radiusMeters: 100,
            billingSetup: {
              paidName: "代币",
              freeName: "活动币",
              hourlyPrice: 15,
              graceMinutes: 5,
              dailyCap: 80,
              botContact: "@arcade_bot",
              autoRegister: true,
              createBotToken: true,
            },
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const data = await res.json() as {
        botToken: string | null;
        shop: { id: string; publicId: string; name: string; timeZone: string; radiusMeters: number };
      };
      expect(data.shop.name).toBe("Neon Arcade");
      expect(data.shop.publicId).toBeDefined();
      expect(data.shop.timeZone).toBe("Asia/Shanghai");
      expect(data.shop.radiusMeters).toBe(100);
      expect(data.botToken).toMatch(/^prism_integration_/);

      // Verify owner can list the shop
      const listRes = await app.request(
        "https://prism.test/api/v1/shops",
        { headers: { cookie: ownerCookie } },
        env,
      );
      expect(listRes.status).toBe(200);
      const listData = await listRes.json() as { shops: Array<{ id: string; name: string }> };
      expect(listData.shops).toHaveLength(1);
      expect(listData.shops[0]!.name).toBe("Neon Arcade");

      // Verify other user does not see this shop
      const otherListRes = await app.request(
        "https://prism.test/api/v1/shops",
        { headers: { cookie: otherCookie } },
        env,
      );
      expect(otherListRes.status).toBe(200);
      const otherListData = await otherListRes.json() as { shops: Array<unknown> };
      expect(otherListData.shops).toHaveLength(0);
    });

    it("updates shop details", async () => {
      const createRes = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "Original Name",
            latitude: 35.6895,
            longitude: 139.6917,
          }),
        },
        env,
      );
      const created = await createRes.json() as { shop: { id: string } };

      const patchRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "Updated Name Tokyo",
            radiusMeters: 150,
          }),
        },
        env,
      );

      expect(patchRes.status).toBe(200);
      const patchData = await patchRes.json() as { shop: { name: string; radiusMeters: number; timeZone: string } };
      expect(patchData.shop.name).toBe("Updated Name Tokyo");
      expect(patchData.shop.radiusMeters).toBe(150);
      expect(patchData.shop.timeZone).toBe("Asia/Tokyo");
    });

    it("serves shop hero image bytes and supports ETag 304", async () => {
      const samplePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const createRes = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "Hero Store",
            latitude: 30,
            longitude: 120,
            heroData: samplePng,
          }),
        },
        env,
      );
      const created = await createRes.json() as { shop: { publicId: string; heroUrl: string } };
      expect(created.shop.heroUrl).toBeDefined();

      const heroRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.publicId}/hero`,
        {},
        env,
      );
      expect(heroRes.status).toBe(200);
      expect(heroRes.headers.get("content-type")).toBe("image/png");
      const etag = heroRes.headers.get("etag")!;
      expect(etag).toBeDefined();

      // If-None-Match test
      const notModifiedRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.publicId}/hero`,
        { headers: { "if-none-match": etag } },
        env,
      );
      expect(notModifiedRes.status).toBe(304);
    });

    it("deletes a shop without business records, prevents non-owner deletion", async () => {
      const createRes = await app.request(
        "https://prism.test/api/v1/shops",
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie: ownerCookie },
          body: JSON.stringify({
            name: "To Be Deleted",
            latitude: 30,
            longitude: 120,
          }),
        },
        env,
      );
      const created = await createRes.json() as { shop: { id: string } };

      // Non-owner cannot delete
      const forbidRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        { method: "DELETE", headers: { cookie: otherCookie } },
        env,
      );
      expect(forbidRes.status).toBe(403);

      // Owner can delete
      const delRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        { method: "DELETE", headers: { cookie: ownerCookie } },
        env,
      );
      expect(delRes.status).toBe(200);

      // Verify it's gone
      const getRes = await app.request(
        `https://prism.test/api/v1/shops/${created.shop.id}`,
        {},
        env,
      );
      expect(getRes.status).toBe(404);
    });
  });

  describe("Web Assets", () => {
    it("recognizes asset-eligible paths", () => {
      expect(isAssetEligiblePath("/index.html")).toBe(true);
      expect(isAssetEligiblePath("/assets/app.js")).toBe(true);
      expect(isAssetEligiblePath("/api/v1/health")).toBe(false);
      expect(isAssetEligiblePath("/callback")).toBe(false);
      expect(isAssetEligiblePath("/.well-known/apple")).toBe(false);
      expect(isAssetEligiblePath("/health")).toBe(false);
      expect(isAssetEligiblePath("/version")).toBe(false);
      expect(isAssetEligiblePath("/t/shop1/mach1")).toBe(false);
    });

    it("serves static assets via Fetcher when ASSETS is configured", async () => {
      const assetApp = new Hono<AppBindings>();
      assetApp.use("*", serveWebAssets());
      assetApp.get("/api/ping", (c) => c.text("pong"));

      const customEnv: Env = {
        ...env,
        ASSETS: {
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            if (url.pathname === "/test.css") {
              return new Response("body { color: red; }", {
                headers: { "content-type": "text/css" },
              });
            }
            return new Response("Not Found", { status: 404 });
          },
        } as Fetcher,
      };

      const assetRes = await assetApp.request("https://prism.test/test.css", {}, customEnv);
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toBe("body { color: red; }");

      const apiRes = await assetApp.request("https://prism.test/api/ping", {}, customEnv);
      expect(apiRes.status).toBe(200);
      expect(await apiRes.text()).toBe("pong");
    });
  });
});
