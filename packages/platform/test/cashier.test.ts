import { beforeEach } from "bun:test";
import { createTestRateLimits } from "./rate-limit-fixture";
const rateLimits = createTestRateLimits();
beforeEach(rateLimits.reset);
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import { createPrismWorkerDependencies } from "@prism/runtime";
import { createD1Repositories } from "@prism/adapter-d1";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";

const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: ["DB"],  compatibilityDate: "2026-06-07" });
let env: Env;
const origin = "https://cashier.test";
async function request(path: string, body?: unknown, session = "owner-session", method = body === undefined ? "GET" : "POST") {
  const response = await app.fetch(new Request(origin + path, { method, headers: { origin, cookie: `arcadelink_session=${session}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const payload = await response.json() as { data?: any; error?: { code: string } };
  return { status: response.status, data: payload.data, error: payload.error };
}
const base = "/api/v1/shops/a/cashier";
const card = { kind: "type-a", uid: "aabbccdd" };
const op = () => crypto.randomUUID();
beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  env = { DB: db, ...rateLimits.bindings, APP_ORIGIN: origin, SESSION_SECRET: "test-only", URL_ENCRYPTION_KEY: "test-only", MUNET_CLIENT_ID: "", MUNET_CLIENT_SECRET: "", APPLE_TEAM_ID: "TEST" } as Env;
  for (const sql of sqliteSchema) await db.prepare(sql).run();
  for (const name of ["0017_platform_accounts", "0018_unified_devices", "0019_ticket_coin", "0020_mahjong_devices", "0021_machine_aliases", "0023_remote_entry", "0024_drop_remote_entry", "0030_platform_identity_bindings", "0029_cashier", "0033_cashier_player_identities"]) {
    const sql = readFileSync(new URL(`../../../migrations/${name}.sql`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "");
    for (const statement of splitD1MigrationStatements(sql)) await db.prepare(statement).run();
  }
  for (const user of ["owner", "viewer", "manager", "other"]) {
    await db.prepare("INSERT INTO users(id,role) VALUES (?,'user')").bind(user).run();
    await db.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,display_name) VALUES (?,?,'munet',?,?)").bind(user, user, user, user).run();
    await db.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01T00:00:00Z')").bind(user, user, await sha256(`${user}-session`)).run();
  }
  for (const shop of ["a", "b", "c"]) {
    await db.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,0,0,80,'owner')").bind(shop, shop, shop).run();
    await db.prepare("INSERT INTO shop_members(shop_id,user_id,role) VALUES (?,'owner','owner')").bind(shop).run();
    await db.prepare("INSERT INTO shop_billing_settings(shop_id,billing_enabled,checkin_geo,checkout_geo,machine_geo,entry_pricing_ids_json) VALUES (?,1,1,1,1,'[\"rate\"]')").bind(shop).run();
    await db.prepare("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,'bot','Bot','integration','test',?,'active','2026-01-01')").bind(shop, await sha256(`${shop}-bot`)).run();
    await db.prepare("INSERT INTO asset_definitions(shop_id,type,code,name) VALUES (?,'currency','paid','余额')").bind(shop).run();
    const now = new Date();
    const repos = createD1Repositories({ db, shopId: shop, id: crypto.randomUUID, now: () => now });
    await repos.pricingConfigs.save({ id: "rate", kind: "time.priority", name: "普通计时", enabled: true, createdAt: now, updatedAt: now,
      provider: { id: "rate", rules: [{ id: "day", label: "标准", priority: 1, dateTimeRange: { start: new Date(+now - 86400_000), end: new Date(+now + 86400_000) }, pricing: { unitMinutes: 60, unitPrice: 12, roundGraceMinutes: 0, priceCap: 100 } }] } });
  }
  await db.prepare("INSERT INTO shop_members(shop_id,user_id,role) VALUES ('a','viewer','staff')").run();
  await db.prepare("INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES ('a','viewer','viewer','Viewer','x','x','viewer','active','2026-01-01','2026-01-01')").run();
  await db.prepare("INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES ('a','viewer','viewer')").run();
  await db.prepare("INSERT INTO shop_members(shop_id,user_id,role) VALUES ('a','manager','staff')").run();
  await db.prepare("INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES ('a','manager','manager','Manager','x','x','manager','active','2026-01-01','2026-01-01')").run();
  await db.prepare("INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES ('a','manager','manager')").run();
}, 30000);
afterAll(() => mf.dispose());

async function setCashier(shop: string, enabled: boolean, extra: Record<string, unknown> = {}, session = "owner-session") {
  return request(`/api/v1/shops/${shop}/settings`, {
    billingEnabled: true, autoRegister: false, locationEnabled: true,
    entryPricingIds: ["rate"], botContact: "", cashierEnabled: enabled, ...extra,
  }, session, "PUT");
}

test("cashier defaults off, requires explicit owner enablement and preserves the flag for older clients", async () => {
  expect((await request("/api/v1/shops/a")).data.shop.cashierEnabled).toBe(false);
  expect((await request("/api/v1/shops/a/settings")).data.cashierEnabled).toBe(false);
  for (const path of ["lookup", "register", "profiles/missing/entry", "profiles/missing/checkout/preview", "profiles/missing/checkout/confirm"]) {
    expect((await request(`${base}/${path}`, {})).error?.code).toBe("CASHIER_DISABLED");
  }
  expect((await setCashier("a", true, {}, "viewer-session")).status).toBe(403);
  expect((await setCashier("a", true)).data.cashierEnabled).toBe(true);
  expect((await request("/api/v1/shops/a")).data.shop.cashierEnabled).toBe(true);
  const legacy = { ...(await request("/api/v1/shops/a/settings")).data };
  delete legacy.cashierEnabled;
  expect((await request("/api/v1/shops/a/settings", legacy, "owner-session", "PUT")).data.cashierEnabled).toBe(true);
  expect((await request("/api/v1/shops/b/settings")).data.cashierEnabled).toBe(false);
  expect((await setCashier("b", true)).status).toBe(200);
});

test("cashier requires shop staff write access, validates basic card IDs, and ignores player GPS", async () => {
  expect((await request(base + "/lookup", card, "missing")).status).toBe(401);
  expect((await request(base + "/lookup", card, "other-session")).status).toBe(403);
  expect((await request(base + "/lookup", card, "viewer-session")).status).toBe(403);
  expect((await request(base + "/lookup", { kind: "felica", uid: "AABBCCDD" })).status).toBe(400);
  expect((await request(base + "/lookup", { kind: "type-a", uid: "not-hex" })).status).toBe(400);
  expect((await request(base + "/lookup", card)).data.profile).toBeNull();
});

test("register, entry, exact-preview external payment and replay leave no assets or accounts", async () => {
  const registerId = op();
  const registration = await request(base + "/register", { card, displayName: "小明", operationId: registerId });
  expect(registration.status).toBe(201);
  const id = registration.data.profile.id;
  expect(registration.data.profile.uid).toBe("AABBCCDD");
  expect((await request(base + "/register", { card, displayName: "小明", operationId: registerId })).data.profile.id).toBe(id);
  expect((await request(base + "/register", { card, displayName: "另一位", operationId: op() })).status).toBe(409);
  const entered = await request(`${base}/profiles/${id}/entry`, { operationId: op() });
  expect(entered.status).toBe(200);
  expect((await request(`${base}/profiles/${id}/entry`, { operationId: op() })).data.session.id).toBe(entered.data.session.id);
  await env.DB.prepare("UPDATE sessions SET started_at=? WHERE shop_id='a' AND id=?").bind(new Date(Date.now() - 15 * 60_000).toISOString(), entered.data.session.id).run();
  const repos = createD1Repositories({ db: env.DB, shopId: "a", id: crypto.randomUUID, now: () => new Date() });
  expect((await repos.players.findById(id))?.paymentMode).toBe("cashier");
  const list = await request("/api/v1/shops/a/staff/players");
  expect(list.data.players.find((p: any) => p.id === id).paymentMode).toBe("cashier");
  const live = await request("/api/v1/shops/a/staff/live-players");
  expect(live.data.players.find((p: any) => p.playerId === id).paymentMode).toBe("cashier");
  expect((await request(`/api/v1/shops/a/staff/players/${id}/assets/grants`, { grants: [{ assetType: "currency", assetCode: "paid", amount: 100 }], operationId: op() })).status).toBe(409);
  expect((await request(`/api/v1/shops/a/staff/players/${id}/checkout/confirm`, { operationId: op() })).status).toBe(409);
  const preview = await request(`${base}/profiles/${id}/checkout/preview`, {});
  expect(preview.status).toBe(200);
  expect(preview.data.settlementPreview.total).toBe(12);
  const collection = { method: "wechat", collected: true, expectedTotal: 12, previewedAt: preview.data.settlementPreview.previewedAt,
    sessionIds: preview.data.settlementPreview.sessionIds, operationId: op() };
  expect((await request(`${base}/profiles/${id}/checkout/confirm`, { ...collection, collected: false })).status).toBe(400);
  const invalid = await request(`${base}/profiles/${id}/checkout/confirm`, { ...collection, expectedTotal: 1, operationId: op() });
  expect(invalid.error?.code).toBe("CASHIER_PREVIEW_CHANGED");
  expect((await repos.sessions.findActiveByPlayerId(id)).length).toBe(1);
  const confirmed = await request(`${base}/profiles/${id}/checkout/confirm`, collection);
  expect(confirmed.status).toBe(200);
  expect(confirmed.data.playerSettlement.total).toBe(12);
  expect(confirmed.data.wallet.balanceAfter).toBe(0);
  expect((await repos.sessions.findById(entered.data.session.id))?.endedAt?.toISOString()).toBe(collection.previewedAt);
  expect((await request(`${base}/profiles/${id}/checkout/confirm`, collection)).data).toEqual(confirmed.data);
  expect((await repos.sessions.findActiveByPlayerId(id)).length).toBe(0);
  expect((await repos.sessions.findUnpaidClosedByPlayerId(id)).length).toBe(0);
  for (const table of ["asset_holdings", "asset_ledger_entries", "asset_transactions", "player_identities", "shop_player_accounts"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE shop_id='a' AND player_id=?`).bind(id).first("n")).toBe(0);
  }
  const payment = await env.DB.prepare("SELECT staff_id,method FROM cashier_payments WHERE shop_id='a'").first();
  expect(payment).toEqual({ staff_id: "account:owner", method: "wechat" });
  const report = await request("/api/v1/shops/a/staff/reports/settlements?from=2026-01-01T00%3A00%3A00Z&to=2999-01-01T00%3A00%3A00Z");
  expect(report.data.settlements[0].externalPayment).toEqual({ method: "wechat", staffId: "account:owner" });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_checkouts WHERE shop_id='a' AND player_id=?").bind(id).first("n")).toBe(1);
  expect((await request("/api/v1/shops/b/cashier/lookup", card)).data.profile).toBeNull();
  expect((await request(`/api/v1/shops/b/cashier/profiles/${id}`)).status).toBe(404);
  expect((await request("/api/v1/shops/b/cashier/register", { card, displayName: "独立档案", operationId: op() })).status).toBe(201);
});

test("storage still rejects cashier assets even outside cashier routes", async () => {
  const lookup = await request(base + "/lookup", card);
  const id = lookup.data.profile.id;
  await expect(env.DB.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES ('a','forbidden',?,'currency','paid',100)").bind(id).run()).rejects.toThrow("CASHIER_PROFILE_RESTRICTED");
});

test("FeliCa IDm is accepted without game-card parsing and stale visits cannot be collected", async () => {
  const registration = await request(base + "/register", { card: { kind: "felica", uid: "0011223344556677" }, displayName: "卡片玩家", operationId: op() });
  const id = registration.data.profile.id;
  await request(`${base}/profiles/${id}/entry`, { operationId: op() });
  const preview = (await request(`${base}/profiles/${id}/checkout/preview`, {})).data.settlementPreview;
  const confirm = { method: "cash", collected: true, expectedTotal: preview.total, previewedAt: preview.previewedAt, sessionIds: preview.sessionIds, operationId: op() };
  const expired = await request(`${base}/profiles/${id}/checkout/confirm`, { ...confirm, previewedAt: new Date(Date.now() - 601_000).toISOString() });
  expect(expired.error?.code).toBe("CASHIER_PREVIEW_EXPIRED");
  const repos = createD1Repositories({ db: env.DB, shopId: "a", id: crypto.randomUUID, now: () => new Date() });
  const session = (await repos.sessions.findActiveByPlayerId(id))[0]!;
  await repos.sessions.save({ ...session, status: "closed", endedAt: new Date(Date.now() + 1000) });
  expect((await request(`${base}/profiles/${id}/checkout/confirm`, { ...confirm, operationId: op() })).error?.code).toBe("CASHIER_PREVIEW_CHANGED");
  expect((await request(`${base}/profiles/${id}/entry`, { operationId: op() })).error?.code).toBe("CASHIER_UNPAID_VISIT");
});


test("a failed collection transaction leaves timing and pricing history intact", async () => {
  const registration = await request(base + "/register", { card: { kind: "type-a", uid: "11223344" }, displayName: "事务玩家", operationId: op() });
  const id = registration.data.profile.id;
  const entered = await request(`${base}/profiles/${id}/entry`, { operationId: op() });
  const deps = createPrismWorkerDependencies({ DB: env.DB }, { shopId: "a" });
  const preview = await deps.staffCheckoutCommands!.previewCheckout!({ playerId: id });
  await env.DB.prepare("CREATE TRIGGER reject_test_collection BEFORE INSERT ON cashier_payments BEGIN SELECT RAISE(ABORT, 'test collection failure'); END").run();
  const collect = () => deps.staffCheckoutCommands!.checkoutExternal!({ playerId: id, staffId: "account:owner", method: "alipay",
    previewedAt: preview.settlementPreview.previewedAt, expectedTotal: preview.settlementPreview.total / 100, sessionIds: preview.settlementPreview.sessionIds });
  try { await expect(collect()).rejects.toThrow("test collection failure"); }
  finally { await env.DB.prepare("DROP TRIGGER reject_test_collection").run(); }
  expect(await env.DB.prepare("SELECT status FROM sessions WHERE shop_id='a' AND id=?").bind(entered.data.session.id).first("status")).toBe("active");
  for (const table of ["player_checkouts", "pricing_history_entries"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE shop_id='a' AND player_id=?`).bind(id).first("n")).toBe(0);
  }
  await collect();
  expect(await env.DB.prepare("SELECT status FROM sessions WHERE shop_id='a' AND id=?").bind(entered.data.session.id).first("status")).toBe("closed");
});

test("mode cannot be enabled without billing or disabled with active or stopped unpaid cashier visits", async () => {
  expect((await setCashier("c", true, { billingEnabled: false })).error?.code).toBe("BILLING_DISABLED");
  expect((await request("/api/v1/shops/c/settings")).data.cashierEnabled).toBe(false);
  expect((await setCashier("c", true)).status).toBe(200);
  const cbase = "/api/v1/shops/c/cashier";
  const registered = await request(cbase + "/register", { card, displayName: "开关玩家", operationId: op() });
  const id = registered.data.profile.id;
  const entry = await request(`${cbase}/profiles/${id}/entry`, { operationId: op() });
  expect((await setCashier("c", false)).error?.code).toBe("CASHIER_UNSETTLED_SESSIONS");
  expect((await request(`/api/v1/shops/c/staff/players/${id}/sessions/${entry.data.session.id}/stop`, { operationId: op() })).status).toBe(200);
  expect((await setCashier("c", false)).error?.code).toBe("CASHIER_UNSETTLED_SESSIONS");
  const preview = (await request(`${cbase}/profiles/${id}/checkout/preview`, {})).data.settlementPreview;
  const confirmed = await request(`${cbase}/profiles/${id}/checkout/confirm`, {
    operationId: op(), collected: true, method: "cash", expectedTotal: preview.total,
    previewedAt: preview.previewedAt, sessionIds: preview.sessionIds,
  });
  expect(confirmed.status).toBe(200);
  expect((await setCashier("c", false)).status).toBe(200);
  expect((await request(cbase + "/lookup", card)).error?.code).toBe("CASHIER_DISABLED");
  expect((await request(`${cbase}/profiles/${id}/entry`, { operationId: op() })).error?.code).toBe("CASHIER_DISABLED");
  expect((await setCashier("c", true)).status).toBe(200);
  expect((await request(cbase + "/lookup", card)).data.profile.id).toBe(id);
});

test("mode updates and cashier writes share a shop lease", async () => {
  const repos = createD1Repositories({ db: env.DB, shopId: "c", id: crypto.randomUUID, now: () => new Date() });
  const leaseId = op();
  const now = new Date();
  expect(await repos.operationLocks.acquire("shop.cashier", "c", leaseId, now, new Date(+now + 60_000))).toBe(true);
  try {
    expect((await setCashier("c", false)).error?.code).toBe("OPERATION_IN_PROGRESS");
    expect((await request("/api/v1/shops/c/cashier/register", { card, displayName: "并发玩家", operationId: op() })).error?.code).toBe("OPERATION_IN_PROGRESS");
  } finally { await repos.operationLocks.release("shop.cashier", "c", leaseId); }
  expect((await setCashier("c", false)).status).toBe(200);
});

test("staff can bind cashier platform identities and verified PRiSM membership appears in both player views", async () => {
  const registered = await request(base + "/register", { card: { kind: "type-a", uid: "FFEEDDCC" }, displayName: "有身份的前台玩家", operationId: op() });
  expect(registered.status).toBe(201);
  const id = registered.data.profile.id, identities = `/api/v1/shops/a/staff/players/${id}/identities`;
  const identity = { provider: "onebot", subject: "114514" };
  expect((await request(identities, identity, "viewer-session")).status).toBe(403);
  expect((await request(identities, identity, "manager-session")).status).toBe(200);
  expect((await request(identities, identity, "manager-session")).status).toBe(200);
  expect((await request(identities, { provider: "telegram", subject: "114514" }, "manager-session")).status).toBe(200);
  expect((await request(identities, { provider: "web-account", subject: "other" })).error?.code).toBe("ACCOUNT_IDENTITY_READ_ONLY");
  const code = (await request("/api/v1/shops/a/platform-binding", {}, "other-session")).data.code;
  expect((await request("/api/v1/shops/a/staff/platform-binding/confirm", { code, ...identity }, "manager-session")).status).toBe(200);
  expect(await env.DB.prepare("SELECT player_id FROM shop_player_accounts WHERE shop_id='a' AND user_id='other'").first("player_id")).toBe(id);
  // This path never saved web-account in the legacy identity table.
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_identities WHERE shop_id='a' AND player_id=? AND provider='web-account'").bind(id).first("n")).toBe(0);
  const repos = createD1Repositories({ db: env.DB, shopId: "a", id: crypto.randomUUID, now: () => new Date() });
  expect((await repos.playerIdentities.findPlayerByIdentity("onebot", "114514"))?.paymentMode).toBe("cashier");
  const auth = createPrismWorkerDependencies({ DB: env.DB }, { shopId: "a" });
  const login = await auth.playerAuthCommands!.loginByIdentity({ identity });
  expect(login.player.paymentMode).toBe("cashier");
  expect((await request(`${base}/profiles/${id}/entry`, { operationId: op() })).status).toBe(200);
  for (const view of ["players", "live-players"]) {
    const players = (await request(`/api/v1/shops/a/staff/${view}`)).data.players;
    const player = players.find((p: any) => (p.id ?? p.playerId) === id);
    expect(player.paymentMode).toBe("cashier");
    expect(player.identities).toEqual(expect.arrayContaining([
      expect.objectContaining(identity),
      expect.objectContaining({ provider: "telegram", subject: "114514" }),
      { provider: "web-account", subject: "other", displayName: "other" },
    ]));
    expect(player.identities.filter((i: any) => i.provider === "web-account")).toHaveLength(1);
  }
  // Deduplicate older accounts that also have a legacy identity record.
  await repos.playerIdentities.save({ playerId: id, provider: "web-account", subject: "other", createdAt: new Date() });
  const listed = (await request("/api/v1/shops/a/staff/players")).data.players.find((p: any) => p.id === id);
  expect(listed.identities.filter((i: any) => i.provider === "web-account")).toHaveLength(1);
  expect((await request(`${identities}/web-account/other`, undefined, "manager-session", "DELETE")).error?.code).toBe("ACCOUNT_IDENTITY_READ_ONLY");
  expect((await request(`/api/v1/shops/a/staff/players/${id}/assets/grants`, { grants: [{ assetType: "currency", assetCode: "paid", amount: 100 }], operationId: op() })).status).toBe(409);
  await expect(auth.staffCheckoutCommands!.checkout!({ playerId: id })).rejects.toMatchObject({ code: "CASHIER_PAYMENT_REQUIRED" });
  const preview = (await request(`${base}/profiles/${id}/checkout/preview`, {})).data.settlementPreview;
  expect((await request(`${base}/profiles/${id}/checkout/confirm`, { operationId: op(), method: "cash", collected: true,
    expectedTotal: preview.total, previewedAt: preview.previewedAt, sessionIds: preview.sessionIds })).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM asset_holdings WHERE shop_id='a' AND player_id=?").bind(id).first("n")).toBe(0);
  expect((await request("/api/v1/shops/b/staff/players")).data.players.flatMap((p: any) => p.identities).some((i: any) => i.subject === "other")).toBe(false);
});
