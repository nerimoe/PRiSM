import { beforeEach } from "bun:test";
import { createTestRateLimits } from "./rate-limit-fixture";
const rateLimits = createTestRateLimits();
beforeEach(rateLimits.reset);
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import { createD1Repositories } from "@prism/adapter-d1";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";
import { utcWriteGuards } from "../src/deployment-gate";

const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: ["DB"],  compatibilityDate: "2026-06-07" });
let env: Env;
const origin = "https://billing-setup.test";
async function request(path: string, body?: unknown, session = "owner-session", method = body === undefined ? "GET" : "POST") {
  const response = await app.fetch(new Request(origin + path, { method, headers: { origin, cookie: `arcadelink_session=${session}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const payload = await response.json() as { data?: any; error?: { code: string; message?: string; details?: any } };
  return { status: response.status, data: payload.data, error: payload.error };
}
const op = () => crypto.randomUUID();
beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  env = { DB: db, ...rateLimits.bindings, APP_ORIGIN: origin, SESSION_SECRET: "test-only", URL_ENCRYPTION_KEY: "test-only", MUNET_CLIENT_ID: "", MUNET_CLIENT_SECRET: "", APPLE_TEAM_ID: "TEST" } as Env;
  for (const sql of sqliteSchema) await db.prepare(sql).run();
  for (const name of ["0017_platform_accounts", "0018_unified_devices", "0019_ticket_coin", "0020_mahjong_devices", "0021_machine_aliases", "0023_remote_entry", "0024_drop_remote_entry", "0030_platform_identity_bindings"]) {
    const sql = readFileSync(new URL(`../../../migrations/${name}.sql`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "");
    for (const statement of splitD1MigrationStatements(sql)) await db.prepare(statement).run();
  }
  for (const user of ["owner", "manager", "viewer", "other"]) {
    await db.prepare("INSERT INTO users(id,role) VALUES (?,'user')").bind(user).run();
    await db.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,display_name) VALUES (?,?,'munet',?,?)").bind(user, user, user, user).run();
    await db.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01T00:00:00Z')").bind(user, user, await sha256(`${user}-session`)).run();
  }
  for (const sql of utcWriteGuards) await db.prepare(sql).run();
}, 30000);
afterAll(() => mf.dispose());

const setup = { paidName: "余额", freeName: "赠送余额", hourlyPrice: 6.75, graceMinutes: 5, dailyCap: 36.5 };
async function store(billingSetup?: Record<string, unknown>) {
  const created = await request("/api/v1/merchant/shops", { name: "原设备店", latitude: 35, longitude: 139, ...(billingSetup ? { billingSetup } : {}) });
  expect(created.status).toBe(201);
  return created.data.shop as { id: string; publicId: string };
}
const count = (table: string, shopId: string) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE shop_id=?`).bind(shopId).first<number>("n");
const convert = (code: string, body: Record<string, unknown> = {}, session = "owner-session") =>
  request(`/api/v1/shops/${code}/billing/setup`, { ...setup, operationId: op(), ...body }, session);

test("store location forms automatically derive the display time zone and ignore client overrides", async () => {
  const created = await request("/api/v1/merchant/shops", {
    name: "东京店", latitude: 35, longitude: 139, timeZone: "America/New_York",
  });
  expect(created.status).toBe(201);
  expect(created.data.shop.timeZone).toBe("Asia/Tokyo");
  const shops = (await request("/api/v1/merchant/shops")).data.shops;
  expect(shops.find((s: any) => s.id === created.data.shop.id).timeZone).toBe("Asia/Tokyo");
  expect((await request(`/api/v1/shops/${created.data.shop.publicId}`)).data.shop.timeZone).toBe("Asia/Tokyo");
  const oldShop = await store();
  expect((await request("/api/v1/merchant/shops")).data.shops.find((s: any) => s.id === oldShop.id).timeZone).toBe("Asia/Tokyo");
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM shops").first("n");
  for (const location of [{ latitude: 91, longitude: 139 }, { latitude: 35, longitude: -181 }]) {
    expect((await request("/api/v1/merchant/shops", { name: "无效位置", ...location })).status).toBe(400);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM shops").first("n")).toBe(before);
});

test("moving a store changes its display zone automatically and preserves UTC pricing and other profile fields", async () => {
  const shop = await store({ ...setup, autoRegister: true });
  await env.DB.prepare("UPDATE app_settings SET value_json=? WHERE shop_id=? AND key='store.profile'")
    .bind(JSON.stringify({ name: "原设备店", timeZone: "Asia/Tokyo", extra: "preserved" }), shop.id).run();
  const pricing = await env.DB.prepare("SELECT * FROM pricing_configs WHERE shop_id=?").bind(shop.id).all();
  const releases = await env.DB.prepare("SELECT * FROM pricing_releases WHERE shop_id=?").bind(shop.id).all();
  const path = `/api/v1/merchant/shops/${shop.id}`;
  const updated = await request(path, { name: "新店名", latitude: 40.7128, longitude: -74.0060 }, "owner-session", "PATCH");
  expect(updated.status).toBe(200);
  expect(updated.data.shop).toMatchObject({ name: "新店名", latitude: 40.7128, timeZone: "America/New_York" });
  expect(JSON.parse((await env.DB.prepare("SELECT value_json FROM app_settings WHERE shop_id=? AND key='store.profile'")
    .bind(shop.id).first<string>("value_json"))!)).toEqual({ name: "新店名", timeZone: "America/New_York", extra: "preserved" });
  expect((await env.DB.prepare("SELECT * FROM pricing_configs WHERE shop_id=?").bind(shop.id).all()).results).toEqual(pricing.results);
  expect((await env.DB.prepare("SELECT * FROM pricing_releases WHERE shop_id=?").bind(shop.id).all()).results).toEqual(releases.results);
  const moved = await request(path, { latitude: 31.2304, longitude: 121.4737, timeZone: "America/New_York" }, "owner-session", "PATCH");
  expect(moved.data.shop.timeZone).toBe("Asia/Shanghai");
  const renamed = await request(path, { name: "上海店" }, "owner-session", "PATCH");
  expect(renamed.data.shop.timeZone).toBe("Asia/Shanghai");
  expect((await request(path, { latitude: 91 }, "owner-session", "PATCH")).status).toBe(400);
  expect(await env.DB.prepare("SELECT latitude FROM shops WHERE id=?").bind(shop.id).first("latitude")).toBe(31.2304);
  const settingsPath = `/api/v1/shops/${shop.publicId}/staff/settings`;
  const settings = (await request(settingsPath)).data.settings;
  settings.store.timeZone = "UTC";
  const saved = await request(settingsPath, settings, "owner-session", "PUT");
  expect(saved.status).toBe(200);
  expect(saved.data.settings.store.timeZone).toBe("Asia/Shanghai");
  await env.DB.prepare("INSERT INTO shop_members(shop_id,user_id,role) VALUES (?,'manager','staff')").bind(shop.id).run();
  expect((await request(path, { timeZone: "UTC" }, "manager-session", "PATCH")).status).toBe(403);
});

test("failed time zone save rolls back the location update in the same transaction", async () => {
  const shop = await store();
  await env.DB.prepare("CREATE TRIGGER fail_display_zone BEFORE INSERT ON app_settings WHEN NEW.key='store.profile' BEGIN SELECT RAISE(ABORT,'test display zone failure'); END").run();
  try {
    expect((await request(`/api/v1/merchant/shops/${shop.id}`, { latitude: 20, timeZone: "UTC" }, "owner-session", "PATCH")).status).toBe(500);
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_display_zone").run();
  }
  expect(await env.DB.prepare("SELECT latitude FROM shops WHERE id=?").bind(shop.id).first("latitude")).toBe(35);
  expect(await count("app_settings", shop.id)).toBe(1);
  expect(JSON.parse((await env.DB.prepare("SELECT value_json FROM app_settings WHERE shop_id=? AND key='store.profile'")
    .bind(shop.id).first<string>("value_json"))!).timeZone).toBe("Asia/Tokyo");
});

test("new billed stores create no Bot credentials by default, with explicit opt-in available", async () => {
  for (const flag of [undefined, false, true]) {
    const created = await request("/api/v1/merchant/shops", {
      name: "计费店", latitude: 35, longitude: 139,
      billingSetup: { ...setup, autoRegister: false, ...(flag === undefined ? {} : { createBotToken: flag }) },
    });
    expect(created.status).toBe(201);
    expect(created.data.botToken === null).toBe(flag !== true);
    expect(await count("api_tokens", created.data.shop.id)).toBe(flag === true ? 1 : 0);
    expect(await count("asset_definitions", created.data.shop.id)).toBe(2);
    expect((await request(`/api/v1/shops/${created.data.shop.publicId}/settings`)).data).toMatchObject({ billingEnabled: true, cashierEnabled: false });
  }
});

test("conversion preserves store data, existing assets and rules; response replay creates no duplicate configuration", async () => {
  const shop = await store();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO asset_definitions(shop_id,type,code,name) VALUES (?,'currency','paid','原余额')").bind(shop.id),
    env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'existing','老玩家','active','2026-01-01')").bind(shop.id),
    env.DB.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES (?,'holding','existing','currency','paid',100)").bind(shop.id),
    env.DB.prepare("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,enabled) VALUES (?,? ,?,'原设备','',1)").bind(op(), op(), shop.id),
    env.DB.prepare(`INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
      VALUES (?,'old','charge.fixed','原规则',1,'active','{"id":"old","amount":5}','2026-01-01','2026-01-01')`).bind(shop.id),
  ]);
  expect((await request(`/api/v1/shops/${shop.publicId}/settings`, {
    billingEnabled: false, autoRegister: true, locationEnabled: true, entryPricingIds: ["old"], botContact: "原联系信息",
  }, "owner-session", "PUT")).status).toBe(200);
  const operationId = op();
  const converted = await convert(shop.publicId, { operationId });
  expect(converted.status).toBe(200);
  expect(converted.data).toMatchObject({ billingEnabled: true, cashierEnabled: false, autoRegister: true, locationEnabled: true, botContact: "原联系信息" });
  expect(converted.data.entryPricingIds).toEqual([converted.data.pricingConfigId]);
  expect((await convert(shop.publicId, { operationId })).data).toEqual(converted.data);
  expect((await convert(shop.publicId, { operationId, hourlyPrice: 10 })).error?.code).toBe("OPERATION_CONFLICT");
  expect((await convert(shop.publicId)).error?.code).toBe("BILLING_ALREADY_ENABLED");
  expect(await count("api_tokens", shop.id)).toBe(0);
  expect(await count("asset_definitions", shop.id)).toBe(2);
  expect(await count("pricing_configs", shop.id)).toBe(2);
  expect(await count("players", shop.id)).toBe(1);
  expect(await count("machines", shop.id)).toBe(1);
  expect(await env.DB.prepare("SELECT name FROM asset_definitions WHERE shop_id=? AND code='paid'").bind(shop.id).first("name")).toBe("原余额");
  expect(await env.DB.prepare("SELECT quantity FROM asset_holdings WHERE shop_id=?").bind(shop.id).first("quantity")).toBe(100);
  const repos = createD1Repositories({ db: env.DB, shopId: shop.id, id: op, now: () => new Date() });
  const pricing = await repos.pricingConfigs.findById(converted.data.pricingConfigId);
  expect(pricing?.kind).toBe("time.priority");
  if (pricing?.kind !== "time.priority") throw new Error("Missing entry pricing");
  expect(pricing.provider.timeZone).toBe("UTC");
  expect(pricing.provider.rules[0]?.pricing).toMatchObject({ unitPrice: 6.75, unitMinutes: 60, roundGraceMinutes: 5, priceCap: 36.5 });
});

test("conversion can enable front desk timing and external collection without any Bot credentials", async () => {
  const shop = await store();
  expect((await convert(shop.publicId, { cashierEnabled: true })).status).toBe(200);
  const base = `/api/v1/shops/${shop.publicId}/cashier`;
  const registered = await request(base + "/register", { card: { kind: "type-a", uid: "01020304" }, displayName: "前台玩家", operationId: op() });
  expect(registered.status).toBe(201);
  const id = registered.data.profile.id;
  const entry = await request(`${base}/profiles/${id}/entry`, { operationId: op() });
  expect(entry.status).toBe(200);
  expect(entry.data.session.startedAt).toEndWith("+09:00");
  const savedStartedAt = await env.DB.prepare("SELECT started_at FROM sessions WHERE shop_id=? AND id=?")
    .bind(shop.id, entry.data.session.id).first<string>("started_at");
  expect(savedStartedAt).toEndWith("Z");
  expect(Date.parse(entry.data.session.startedAt)).toBe(Date.parse(savedStartedAt!));
  await env.DB.prepare("UPDATE sessions SET started_at=? WHERE shop_id=? AND id=?").bind(new Date(Date.now() - 15 * 60_000).toISOString(), shop.id, entry.data.session.id).run();
  const preview = (await request(`${base}/profiles/${id}/checkout/preview`, {})).data.settlementPreview;
  expect(preview.total).toBe(6.75);
  expect((await request(`${base}/profiles/${id}/checkout/confirm`, {
    operationId: op(), collected: true, method: "cash", expectedTotal: preview.total, previewedAt: preview.previewedAt, sessionIds: preview.sessionIds,
  })).status).toBe(200);
  expect(await count("api_tokens", shop.id)).toBe(0);
  expect(await count("asset_holdings", shop.id)).toBe(0);
  expect(await count("cashier_payments", shop.id)).toBe(1);
});

test("manual billing settings require assets and entry pricing but not a Bot token", async () => {
  const shop = await store();
  const body = { billingEnabled: true, autoRegister: false, locationEnabled: false, entryPricingIds: [], botContact: "" };
  expect((await request(`/api/v1/shops/${shop.publicId}/settings`, body, "owner-session", "PUT")).error?.code).toBe("BILLING_CONFIGURATION_REQUIRED");
  expect((await convert(shop.publicId)).status).toBe(200);
  const settings = (await request(`/api/v1/shops/${shop.publicId}/settings`)).data;
  expect((await request(`/api/v1/shops/${shop.publicId}/settings`, { ...settings, billingEnabled: false }, "owner-session", "PUT")).status).toBe(200);
  expect((await request(`/api/v1/shops/${shop.publicId}/settings`, settings, "owner-session", "PUT")).status).toBe(200);
  expect(await count("api_tokens", shop.id)).toBe(0);
});

test("manual asset and pricing APIs complete setup without enabling billing or creating duplicate rules", async () => {
  const shop = await store();
  const base = `/api/v1/shops/${shop.publicId}`;
  for (const code of ["paid", "free"]) {
    expect((await request(`${base}/staff/asset-definitions/currency/${code}`, {
      name: code, stackable: true,
    }, "owner-session", "PUT")).status).toBe(200);
  }
  const created = await request(`${base}/staff/pricing-configs`, {
    kind: "time.priority", name: "手动入场", enabled: true,
    provider: { id: op(), timeZone: "UTC", rules: [{ id: op(), label: "全天", priority: 0,
      timeRange: { start: "00:00", end: "00:00" },
      pricing: { unitMinutes: 60, unitPrice: 18, roundGraceMinutes: 10, priceCap: 90 } }] },
  });
  expect(created.status).toBe(200);
  const settings = (await request(`${base}/settings`)).data;
  const selected = { ...settings, entryPricingIds: [created.data.pricingConfig.id] };
  const saved = await request(`${base}/settings`, selected, "owner-session", "PUT");
  expect(saved.status).toBe(200);
  expect(saved.data.billingEnabled).toBe(false);
  expect(saved.data.billingConfiguration).toMatchObject({ ready: true, balanceAssetsReady: true, entryPricingReady: true });
  expect((await request(`${base}/settings`)).data.billingConfiguration.ready).toBe(true);
  expect((await request(`${base}/settings`, { ...selected, billingEnabled: true }, "owner-session", "PUT")).status).toBe(200);
  expect(await count("pricing_configs", shop.id)).toBe(1);
  expect(await count("api_tokens", shop.id)).toBe(0);
});

test("settings identify stale selections and exclude caps from entry rules without accepting invalid configuration", async () => {
  const shop = await store({ ...setup, autoRegister: false });
  const base = `/api/v1/shops/${shop.publicId}`;
  const settings = (await request(`${base}/settings`)).data;
  const id = settings.entryPricingIds[0];
  expect((await request(`${base}/staff/pricing-configs/${id}/archive`, {})).status).toBe(200);
  const rejected = await request(`${base}/settings`, settings, "owner-session", "PUT");
  expect(rejected.status).toBe(409);
  expect(rejected.error?.details).toMatchObject({ balanceAssetsReady: true, entryPricingReady: false, invalidEntryPricingIds: [id] });
  expect(rejected.error?.message).not.toBe("请先配置余额资产和入场规则");
  const missing = await request(`${base}/settings`, { ...settings, entryPricingIds: [] }, "owner-session", "PUT");
  expect(missing.error?.message).toBe("请选择至少一个入场计费规则");
  const cap = await request(`${base}/staff/pricing-configs`, {
    kind: "time.cap", name: "消费封顶", enabled: true,
    provider: { id: op(), timeZone: "UTC", includedPricingConfigIds: [id], rules: [{ id: op(), label: "全天", priority: 0,
      timeRange: { start: "00:00", end: "00:00" }, priceCap: 90 }] },
  });
  expect(cap.status).toBe(200);
  const capId = cap.data.pricingConfig.id;
  const invalidCap = await request(`${base}/settings`, { ...settings, entryPricingIds: [capId] }, "owner-session", "PUT");
  expect(invalidCap.status).toBe(409);
  expect(invalidCap.error?.details.invalidEntryPricingIds).toEqual([capId]);
});

test("conversion is owner-only and invalid requests write no configuration", async () => {
  const shop = await store();
  for (const role of ["manager", "viewer"]) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO shop_members(shop_id,user_id,role) VALUES (?,?,'staff')").bind(shop.id, role),
      env.DB.prepare("INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active','2026-01-01','2026-01-01')").bind(shop.id, role, role, role, "x", "x", role),
      env.DB.prepare("INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES (?,?,?)").bind(shop.id, role, role),
    ]);
    expect((await convert(shop.publicId, {}, `${role}-session`)).status).toBe(403);
  }
  expect((await convert(shop.publicId, {}, "missing")).status).toBe(401);
  expect((await convert(shop.publicId, {}, "other-session")).status).toBe(403);
  for (const invalid of [{ hourlyPrice: 0 }, { graceMinutes: 1.5 }, { dailyCap: -1 }, { operationId: "invalid" }]) {
    expect((await convert(shop.publicId, invalid)).status).toBe(400);
  }
  expect(await count("asset_definitions", shop.id)).toBe(0);
  expect(await count("pricing_configs", shop.id)).toBe(0);
  expect((await request(`/api/v1/shops/${shop.publicId}/settings`)).data.billingEnabled).toBe(false);
});

test("a failed setup transaction rolls back assets, pricing and mode together", async () => {
  const shop = await store();
  const operationId = op();
  await env.DB.prepare("CREATE TRIGGER fail_billing_setup BEFORE INSERT ON app_settings WHEN NEW.key='cashier.settings' BEGIN SELECT RAISE(ABORT,'test setup failure'); END").run();
  try { expect((await convert(shop.publicId, { operationId })).status).toBe(500); }
  finally { await env.DB.prepare("DROP TRIGGER fail_billing_setup").run(); }
  for (const table of ["asset_definitions", "pricing_configs", "shop_billing_settings"]) {
    expect(await count(table, shop.id)).toBe(0);
  }
  expect(await count("player_operations", shop.id)).toBe(0);
  expect(await count("app_settings", shop.id)).toBe(1);
  const retried = await convert(shop.publicId, { operationId });
  expect(retried.status).toBe(200);
  expect((await convert(shop.publicId, { operationId })).data).toEqual(retried.data);
  expect(await count("pricing_configs", shop.id)).toBe(1);
});

test("conversion recovers old incomplete operation IDs after the UTC write failure without duplicate setup", async () => {
  for (const status of ["unknown", "pending"]) {
    const shop = await store();
    const operationId = op();
    const requestHash = await sha256(JSON.stringify({ ...setup, cashierEnabled: false }));
    await env.DB.prepare(`INSERT INTO player_operations(shop_id,user_id,id,kind,status,request_hash,created_at)
      VALUES (?,'owner',?,'billing/setup',?,?,?)`).bind(shop.id, operationId, status, requestHash, new Date().toISOString()).run();
    const converted = await convert(shop.publicId, { operationId });
    expect(converted.status).toBe(200);
    expect((await convert(shop.publicId, { operationId })).data).toEqual(converted.data);
    expect(await count("pricing_configs", shop.id)).toBe(1);
    expect(await count("player_operations", shop.id)).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM player_operations WHERE shop_id=? AND id=?")
      .bind(shop.id, operationId).first("status")).toBe("completed");
  }
});

test("failure to store the successful conversion response rolls back configuration too", async () => {
  const shop = await store();
  const operationId = op();
  await env.DB.prepare(`CREATE TRIGGER fail_setup_response BEFORE UPDATE ON player_operations
    WHEN NEW.kind='billing/setup' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'test response failure'); END`).run();
  try { expect((await convert(shop.publicId, { operationId })).status).toBe(500); }
  finally { await env.DB.prepare("DROP TRIGGER fail_setup_response").run(); }
  for (const table of ["asset_definitions", "pricing_configs", "shop_billing_settings", "player_operations"]) {
    expect(await count(table, shop.id)).toBe(0);
  }
  expect((await convert(shop.publicId, { operationId })).status).toBe(200);
  expect(await count("pricing_configs", shop.id)).toBe(1);
});

test("conversion preserves archived assets and asks the owner to restore them", async () => {
  const shop = await store();
  await env.DB.prepare("INSERT INTO asset_definitions(shop_id,type,code,name,status) VALUES (?,'currency','paid','旧余额','archived')").bind(shop.id).run();
  expect((await convert(shop.publicId)).error?.code).toBe("BILLING_ASSETS_ARCHIVED");
  expect(await env.DB.prepare("SELECT status FROM asset_definitions WHERE shop_id=? AND code='paid'").bind(shop.id).first("status")).toBe("archived");
  expect(await count("pricing_configs", shop.id)).toBe(0);
});

test("conversion uses the same shop lease as manual settings and front desk writes", async () => {
  const shop = await store();
  const repos = createD1Repositories({ db: env.DB, shopId: shop.id, id: op, now: () => new Date() });
  const leaseId = op();
  const now = new Date();
  expect(await repos.operationLocks.acquire("shop.cashier", shop.id, leaseId, now, new Date(+now + 60_000))).toBe(true);
  const operationId = op();
  try { expect((await convert(shop.publicId, { operationId })).error?.code).toBe("OPERATION_IN_PROGRESS"); }
  finally { await repos.operationLocks.release("shop.cashier", shop.id, leaseId); }
  expect((await convert(shop.publicId, { operationId })).status).toBe(200);
  expect(await count("pricing_configs", shop.id)).toBe(1);
});
