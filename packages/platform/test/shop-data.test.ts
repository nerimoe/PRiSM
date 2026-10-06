import { beforeEach } from "bun:test";
import { createTestRateLimits } from "./rate-limit-fixture";
const rateLimits = createTestRateLimits();
beforeEach(rateLimits.reset);
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";
import { utcWriteGuards } from "../src/deployment-gate";

const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: ["DB", "RESTORE_DB"],  compatibilityDate: "2026-06-07" });
let env: Env;
const origin = "https://shop-data.test";
async function request(path: string, body?: unknown, session = "owner-session", method = body === undefined ? "GET" : "POST") {
  const response = await app.fetch(new Request(origin + path, { method, headers: { origin, cookie: `arcadelink_session=${session}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const payload = await response.json() as { data?: any; error?: { code: string; message?: string; details?: any } };
  return { status: response.status, data: payload.data, error: payload.error };
}
const op = () => crypto.randomUUID();
async function initialize(db: D1Database, prefix = ""): Promise<Env> {
  const fixture = { DB: db, ...rateLimits.bindings, APP_ORIGIN: origin, SESSION_SECRET: "test-only", URL_ENCRYPTION_KEY: "test-only", MUNET_CLIENT_ID: "", MUNET_CLIENT_SECRET: "", APPLE_TEAM_ID: "TEST" } as Env;
  for (const sql of sqliteSchema) await db.prepare(sql).run();
  for (const name of ["0017_platform_accounts", "0018_unified_devices", "0019_ticket_coin", "0020_mahjong_devices", "0021_machine_aliases", "0023_remote_entry", "0024_drop_remote_entry", "0030_platform_identity_bindings"]) {
    const sql = readFileSync(new URL(`../../../migrations/${name}.sql`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "");
    for (const statement of splitD1MigrationStatements(sql)) await db.prepare(statement).run();
  }
  for (const name of ["owner", "manager", "viewer", "other"]) {
    const user = prefix + name;
    await db.prepare("INSERT INTO users(id,role) VALUES (?,'user')").bind(user).run();
    await db.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,display_name) VALUES (?,?,'munet',?,?)").bind(user, user, user, user).run();
    await db.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01T00:00:00Z')").bind(user, user, await sha256(`${name}-session`)).run();
  }
  for (const sql of utcWriteGuards) await db.prepare(sql).run();
  return fixture;
}
beforeAll(async () => { env = await initialize(await mf.getD1Database("DB")); }, 30000);
afterAll(() => mf.dispose());

const setup = { paidName: "余额", freeName: "赠送", hourlyPrice: 18, graceMinutes: 10, dailyCap: 90, autoRegister: true };
async function store(configured = false) {
  const result = await request("/api/v1/merchant/shops", {
    name: configured ? "来源东京店" : "目标东京店", latitude: 35, longitude: 139,
    ...(configured ? { billingSetup: setup } : {}),
  });
  expect(result.status).toBe(201);
  return result.data.shop as { id: string; publicId: string };
}
const base = (shop: { publicId: string }) => `/api/v1/shops/${shop.publicId}/data`;
async function exportData(shop: { publicId: string }, scope = "business", session = "owner-session", legacy = false) {
  const path = `${base(shop)}/export?scope=${scope}`.replace(legacy ? "/api/v1/" : "___", "/api/");
  const response = await app.fetch(new Request(origin + path, { headers: { cookie: `arcadelink_session=${session}` } }), env);
  return { response, backup: await response.json() as any };
}
async function preview(shop: { publicId: string }, backup: unknown) {
  return request(`${base(shop)}/import/preview`, { backup });
}
async function apply(shop: { publicId: string }, backup: unknown, fingerprint: string, operationId = op()) {
  return request(`${base(shop)}/import/apply`, { backup, fingerprint, operationId });
}
const rows = async (table: string, shopId: string) => (await env.DB.prepare(`SELECT * FROM ${table} WHERE shop_id=? ORDER BY rowid`).bind(shopId).all()).results
  .map(({ shop_id, ...row }) => row);
async function sourceData() {
  const source = await store(true);
  const config = (await rows("pricing_configs", source.id))[0]!;
  const started = "2026-10-01T23:08:00.000Z";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,'p','玩家','active',?)").bind(source.id, started),
    env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'p','telegram','114514',?)").bind(source.id, started),
    env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'p','web-account','owner',?)").bind(source.id, started),
    env.DB.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES (?,'h','p','currency','paid',12345)").bind(source.id),
    env.DB.prepare("INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status,pricing_config_ids_json,payment_status) VALUES (?,'s','p',?,?,'closed',?,'paid')").bind(source.id, started, "2026-10-02T00:08:00.000Z", JSON.stringify([config.id])),
    env.DB.prepare("INSERT INTO player_checkouts(shop_id,id,player_id,subtotal,total,status,settled_at) VALUES (?,'c','p',1800,1800,'settled',?)").bind(source.id, started),
    env.DB.prepare("INSERT INTO settlements(shop_id,id,session_id,checkout_id,subtotal,total,status,settled_at) VALUES (?,'bill','s','c',1800,1800,'settled',?)").bind(source.id, started),
    env.DB.prepare("INSERT INTO checkout_timelines(shop_id,checkout_id,timeline_json) VALUES (?,'c',?)").bind(source.id, JSON.stringify({ events: [{ startedAt: started }] })),
    env.DB.prepare("INSERT INTO sessions(shop_id,id,player_id,started_at,status,pricing_config_ids_json,payment_status) VALUES (?,'active','p',?,'active',?,'unpaid')").bind(source.id, started, JSON.stringify([config.id])),
    env.DB.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'devices.homeassistant_connection','{\"url\":\"https://ha.invalid\",\"token\":\"do-not-export\"}',?)").bind(source.id, started),
  ]);
  return source;
}

test("business JSON is a raw UTC storage artifact, with no secrets or web account links", async () => {
  const source = await sourceData();
  for (const legacy of [false, true]) {
    const { response, backup } = await exportData(source, "business", "owner-session", legacy);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain('.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(backup.format).toBe("prism-shop-data");
    expect(backup.data).toBeUndefined();
    expect(backup.tables.asset_holdings[0].quantity).toBe(12345);
    expect(backup.tables.sessions[0].started_at).toBe("2026-10-01T23:08:00.000Z");
    expect(JSON.parse(backup.tables.checkout_timelines[0].timeline_json).events[0].startedAt).toBe("2026-10-01T23:08:00.000Z");
    expect(backup.tables.player_identities).toHaveLength(1);
    expect(backup.tables.player_identities[0].provider).toBe("telegram");
    expect(JSON.stringify(backup)).not.toContain("do-not-export");
    expect(backup.tables.staff_users).toBeUndefined();
  }
});

test("business restore preserves balances, bills, current and historical pricing byte for byte, and replays safely", async () => {
  const source = await sourceData(), target = await store();
  const { backup } = await exportData(source);
  const check = await preview(target, backup);
  expect(check.status).toBe(200);
  expect(check.data.errors).toEqual([]);
  expect(check.data.canImport).toBe(true);
  const id = op();
  const restored = await apply(target, backup, check.data.fingerprint, id);
  expect(restored.status).toBe(200);
  expect(restored.data.imported).toBe(true);
  for (const [table, expected] of Object.entries(backup.tables)) expect(await rows(table, target.id)).toEqual(expected);
  expect(await env.DB.prepare("SELECT name FROM shops WHERE id=?").bind(target.id).first("name")).toBe("目标东京店");
  expect(JSON.parse(String((await rows("app_settings", target.id)).find(row => row.key === "store.profile")!.value_json)).timeZone).toBe("Asia/Tokyo");
  expect((await apply(target, backup, check.data.fingerprint, id)).data).toEqual(restored.data);
  expect((await apply(target, { ...backup, exportedAt: new Date().toISOString() }, check.data.fingerprint, id)).error?.code).toBe("OPERATION_CONFLICT");
  expect((await preview(target, backup)).data.canImport).toBe(false);
  expect((await apply(target, backup, check.data.fingerprint)).error?.code).toBe("IMPORT_NOT_READY");
  expect(await rows("asset_holdings", source.id)).toEqual(backup.tables.asset_holdings);
  // Normal SQL publications and session bindings still work after restore.
  const before = (await rows("pricing_config_versions", target.id)).length;
  await env.DB.prepare("UPDATE pricing_configs SET name='新规则' WHERE shop_id=?").bind(target.id).run();
  expect((await rows("pricing_config_versions", target.id)).length).toBe(before + 1);
  await env.DB.prepare("INSERT INTO sessions(shop_id,id,player_id,started_at,status) VALUES (?,'next','p',?,'active')").bind(target.id, new Date().toISOString()).run();
  expect((await rows("session_pricing_releases", target.id)).some(row => row.session_id === "next")).toBe(true);
});

test("configuration transfer omits players and financial history and publishes new UTC versions", async () => {
  const source = await sourceData(), target = await store();
  const { backup } = await exportData(source, "configuration");
  expect(backup.tables.players).toBeUndefined();
  expect(backup.tables.settlements).toBeUndefined();
  const check = await preview(target, backup);
  expect(check.data.errors).toEqual([]);
  expect((await apply(target, backup, check.data.fingerprint)).status).toBe(200);
  expect(await rows("players", target.id)).toEqual([]);
  expect((await rows("pricing_releases", target.id)).every(row => row.time_zone === "UTC")).toBe(true);
});

test("rollback restores automatic pricing triggers and leaves the same operation retryable", async () => {
  const source = await sourceData(), target = await store();
  const { backup } = await exportData(source);
  const check = await preview(target, backup), id = op();
  await env.DB.prepare(`CREATE TRIGGER reject_test_restore BEFORE INSERT ON shop_billing_settings
    WHEN NEW.shop_id='${target.id}' BEGIN SELECT RAISE(ABORT,'test final settings failure'); END`).run();
  try { expect((await apply(target, backup, check.data.fingerprint, id)).status).toBe(500); }
  finally { await env.DB.prepare("DROP TRIGGER reject_test_restore").run(); }
  for (const table of Object.keys(backup.tables)) expect(await rows(table, target.id)).toEqual([]);
  expect(await rows("player_operations", target.id)).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('pricing_config_version_insert','session_pricing_bind')").first("n")).toBe(2);
  expect((await apply(target, backup, check.data.fingerprint, id)).status).toBe(200);
});

test("preflight validates fields, foreign keys, UTC rules and identity restrictions without writing", async () => {
  const source = await sourceData(), target = await store();
  const { backup } = await exportData(source);
  const changes = [
    (b: any) => { b.tables.players[0].shop_id = source.id; },
    (b: any) => { b.tables.asset_holdings[0].player_id = "missing"; },
    (b: any) => { b.tables.player_identities[0].provider = "web-account"; },
    (b: any) => { b.tables.pricing_configs[0].provider_json = JSON.stringify({ timeZone: "Asia/Tokyo" }); },
    (b: any) => { b.tables.asset_holdings[0].quantity = 1.5; },
    (b: any) => { b.tables.sessions[0].started_at = "invalid-time"; },
    (b: any) => { b.tables.players.push(b.tables.players[0]); },
    (b: any) => { b.tables.pricing_releases[0].version_ids_json = '["missing"]'; },
  ];
  for (const mutate of changes) {
    rateLimits.reset();
    const changed = structuredClone(backup); mutate(changed);
    const check = await preview(target, changed);
    expect(check.status).toBe(200);
    expect(check.data.canImport).toBe(false);
    expect(check.data.errors.length).toBeGreaterThan(0);
    expect((await apply(target, changed, check.data.fingerprint)).error?.code).toBe("IMPORT_NOT_READY");
  }
  expect((await preview(target, { ...backup, version: 99 })).error?.code).toBe("INVALID_BACKUP");
  expect((await preview(target, { ...backup, tables: { ...backup.tables, users: [] } })).data.canImport).toBe(false);
  expect(await rows("players", target.id)).toEqual([]);
});

test("file or target changes invalidate the preflight; existing stores cannot be overwritten", async () => {
  const source = await sourceData(), target = await store();
  const { backup } = await exportData(source), check = await preview(target, backup);
  expect((await apply(target, { ...backup, exportedAt: "2026-01-01T00:00:00.000Z" }, check.data.fingerprint)).error?.code).toBe("IMPORT_TARGET_CHANGED");
  await env.DB.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'cashier.settings','{\"enabled\":false}',?)").bind(target.id, new Date().toISOString()).run();
  expect((await apply(target, backup, check.data.fingerprint)).error?.code).toBe("IMPORT_TARGET_CHANGED");
  expect((await preview(source, backup)).data.canImport).toBe(false);
});

test("owner permission is required on export, preflight and apply", async () => {
  const source = await sourceData();
  const { backup } = await exportData(source);
  await env.DB.prepare("INSERT INTO shop_members(shop_id,user_id,role) VALUES (?,'manager','staff')").bind(source.id).run();
  for (const session of ["manager-session", "other-session", "missing"]) {
    const expected = session === "missing" ? 401 : 403;
    expect((await exportData(source, "business", session)).response.status).toBe(expected);
    expect((await request(`${base(source)}/import/preview`, { backup }, session)).status).toBe(expected);
    expect((await request(`${base(source)}/import/apply`, { backup, fingerprint: "a".repeat(64), operationId: op() }, session)).status).toBe(expected);
  }
});

test("business files migrate to an independent database with different platform account IDs and encryption keys", async () => {
  const source = await sourceData();
  const { backup } = await exportData(source);
  const sourceEnv = env;
  try {
    env = await initialize(await mf.getD1Database("RESTORE_DB"), "production-");
    env.URL_ENCRYPTION_KEY = "a-different-encryption-key";
    const target = await store();
    const check = await preview(target, backup);
    expect(check.data.canImport).toBe(true);
    expect((await apply(target, backup, check.data.fingerprint)).status).toBe(200);
    for (const [table, expected] of Object.entries(backup.tables)) expect(await rows(table, target.id)).toEqual(expected);
    expect(await env.DB.prepare("SELECT created_by FROM shops WHERE id=?").bind(target.id).first("created_by")).toBe("production-owner");
    expect(await rows("shop_player_accounts", target.id)).toEqual([]);
    expect((await rows("player_identities", target.id))[0]!.provider).toBe("telegram");
  } finally { env = sourceEnv; }
}, 30000);

test("the atomic apply guard detects a write after the final state read", async () => {
  const source = await sourceData(), target = await store();
  const { backup } = await exportData(source), check = await preview(target, backup);
  const originalEnv = env, db = env.DB;
  let guardPrepared = false, raced = false;
  env = { ...env, DB: {
    prepare(sql: string) { if (sql.startsWith("INSERT INTO player_operations")) guardPrepared = true; return db.prepare(sql); },
    async batch(statements: D1PreparedStatement[]) {
      if (guardPrepared && !raced) {
        raced = true;
        await db.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES (?,'player.registration','{\"defaultPresentId\":null}',?)")
          .bind(target.id, new Date().toISOString()).run();
      }
      return db.batch(statements);
    },
  } as D1Database };
  try { expect((await apply(target, backup, check.data.fingerprint)).error?.code).toBe("IMPORT_TARGET_CHANGED"); }
  finally { env = originalEnv; }
  expect(raced).toBe(true);
  expect(await rows("players", target.id)).toEqual([]);
  expect(await rows("player_operations", target.id)).toEqual([]);
});

test("large single tables are restored in bounded batches without dropping ledger records", async () => {
  const source = await sourceData(), target = await store();
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1800)
    INSERT INTO asset_transactions(shop_id,id,player_id,kind,ref_id,created_at,metadata_json)
    SELECT ?,'tx-'||x,'p','test','historical-ref','2026-10-01T23:08:00Z',json_object('note',hex(zeroblob(600))) FROM n`).bind(source.id).run();
  const { backup } = await exportData(source);
  expect(backup.tables.asset_transactions).toHaveLength(1800);
  expect(JSON.stringify(backup.tables.asset_transactions).length).toBeGreaterThan(1024 * 1024);
  const check = await preview(target, backup);
  expect(check.data.errors).toEqual([]);
  expect((await apply(target, backup, check.data.fingerprint)).status).toBe(200);
  expect(await rows("asset_transactions", target.id)).toEqual(backup.tables.asset_transactions);
}, 30000);

test("malformed JSON and oversized uploads are rejected before applying any data", async () => {
  const target = await store();
  for (const [content, status] of [["{bad-json", 400], ['"' + "x".repeat(10 * 1024 * 1024 + 2048) + '"', 413]] as const) {
    const response = await app.fetch(new Request(origin + base(target) + "/import/preview", {
      method: "POST", headers: { origin, cookie: "arcadelink_session=owner-session", "content-type": "application/json" }, body: content,
    }), env);
    expect(response.status).toBe(status);
  }
  expect(await rows("players", target.id)).toEqual([]);
});

test("exports fail explicitly for oversized individual records rather than creating an unrestorable file", async () => {
  const source = await sourceData();
  await env.DB.prepare("UPDATE sessions SET metadata_json=? WHERE shop_id=? AND id='s'")
    .bind(JSON.stringify({ note: "x".repeat(128 * 1024) }), source.id).run();
  const { response, backup } = await exportData(source);
  expect(response.status).toBe(413);
  expect(backup.error.code).toBe("BACKUP_TOO_LARGE");
});

test("unconfigured shop exports preserve the effective API defaults", async () => {
  const source = await store();
  const { backup } = await exportData(source);
  const current = (await request(`/api/v1/shops/${source.publicId}/settings`)).data;
  for (const key of ['billingEnabled', 'cashierEnabled', 'autoRegister', 'identityBindingRequired', 'checkinGeo', 'checkoutGeo', 'machineGeo'])
    expect(backup.settings[key]).toBe(current[key]);
});
