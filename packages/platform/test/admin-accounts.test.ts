import { beforeEach } from "bun:test";
import { createTestRateLimits } from "./rate-limit-fixture";
const rateLimits = createTestRateLimits();
beforeEach(rateLimits.reset);
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { sqliteSchema, splitD1MigrationStatements } from "@prism/storage-sql";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import { provisionMunetUser } from "../src/munet-appclip";
import type { AppBindings, Env } from "../src/types";

const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('test')}}", d1Databases: ["DB"],  compatibilityDate: "2026-06-07" });
const origin = "https://admin-account.test";
let env: Env;
async function request(path: string, user = "admin", method = "DELETE", body?: unknown) {
  const response = await app.fetch(new Request(origin + path, { method, headers: { origin, cookie: `arcadelink_session=${user}-token`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: response.status, ...await response.json() as { data?: any; error?: { code: string } } };
}
async function seedUser(id: string, role = "user") {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,role) VALUES (?,?)").bind(id, role),
    env.DB.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,username,display_name) VALUES (?,?,'munet',?,?,?)").bind(id, id, id, id, id),
    env.DB.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01')").bind(id, id, await sha256(`${id}-token`)),
    env.DB.prepare("INSERT INTO oauth_credentials(identity_id,access_token_encrypted,access_token_expires_at,refresh_token_encrypted) VALUES (?,'test','2999-01-01','test')").bind(id),
    env.DB.prepare("INSERT INTO cards(id,user_id,label,access_code) VALUES (?,?,?,?)").bind(id, id, id, id),
    env.DB.prepare("INSERT INTO passkeys(id,user_id,public_key,device_type) VALUES (?,?,?,'singleDevice')").bind(id, id, new Uint8Array([1, 2, 3])),
    env.DB.prepare("INSERT INTO auth_challenges(id,user_id,purpose,challenge,expires_at) VALUES (?,?,'appclip-munet-code','test','2999-01-01')").bind(id, id),
  ]);
}
async function seedShop(id: string, creator: string, owner = creator) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,created_by) VALUES (?,?,?,35,139,?)").bind(id, id, id, creator),
    env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES (?,?,?,'owner')").bind(id, id, owner),
  ]);
}
beforeAll(async () => {
  env = { DB: await mf.getD1Database("DB"), ...rateLimits.bindings, APP_ORIGIN: origin, SESSION_SECRET: "test", URL_ENCRYPTION_KEY: "test", MUNET_CLIENT_ID: "", MUNET_CLIENT_SECRET: "", APPLE_TEAM_ID: "TEST" } as Env;
  for (const sql of sqliteSchema) await env.DB.prepare(sql).run();
  for (const name of ["0017_platform_accounts", "0018_unified_devices", "0019_ticket_coin", "0020_mahjong_devices", "0021_machine_aliases", "0023_remote_entry", "0024_drop_remote_entry", "0025_live_activity_push_tokens", "0026_live_activity_start_tokens", "0030_platform_identity_bindings"])
    for (const sql of splitD1MigrationStatements(readFileSync(new URL(`../../../migrations/${name}.sql`, import.meta.url), "utf8"))) await env.DB.prepare(sql).run();
  await seedUser("admin", "admin");
  await seedUser("regular");
}, 30000);
afterAll(() => mf.dispose());

test("only platform administrators can delete another account; self deletion and missing targets do not mutate data", async () => {
  await seedUser("protected");
  await seedShop("protected-store", "regular");
  const path = "/api/v1/admin/users/protected";
  expect((await request(path, "anonymous")).status).toBe(401);
  expect((await request(path, "regular")).status).toBe(403);
  expect((await request("/api/v1/admin/users/admin")).error?.code).toBe("CANNOT_DELETE_CURRENT_USER");
  expect((await request("/api/v1/admin/users/missing")).status).toBe(404);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id IN ('protected','admin')").first("n")).toBe(2);
  expect((await request("/api/v1/me", "admin", "GET")).status).toBe(200);
});

test("deletion revokes every login and account binding while preserving bills, balances and anonymous device history; MuNET registers anew", async () => {
  const user = "reset";
  await seedUser(user);
  await seedShop("reset-store", user);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('reset-store','p','Player','active','2026-01-01')"),
    env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('reset-store','p','telegram','114514','2026-01-01')"),
    env.DB.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('reset-store','reset','p','2026-01-01')"),
    env.DB.prepare("INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at) VALUES ('reset-store','reset','telegram','114514','2026-01-01')"),
    env.DB.prepare("INSERT INTO platform_binding_codes(shop_id,user_id,code_hash,expires_at,created_at) VALUES ('reset-store','reset','binding','2999-01-01','2026-01-01')"),
    env.DB.prepare("INSERT INTO staff_users(shop_id,id,username,display_name,password_hash,password_salt,role,status,created_at,updated_at) VALUES ('reset-store','staff','staff','Staff','','','owner','active','2026-01-01','2026-01-01')"),
    env.DB.prepare("INSERT INTO shop_staff_accounts(shop_id,user_id,staff_id) VALUES ('reset-store','reset','staff')"),
    env.DB.prepare("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('reset-machine','reset-machine','reset-store','Machine','')"),
    env.DB.prepare("INSERT INTO machine_tickets(token_hash,machine_id,expires_at,claimed_by) VALUES ('reset-ticket','reset-machine','2999-01-01','reset')"),
    env.DB.prepare("INSERT INTO player_operations(shop_id,user_id,id,kind,status,created_at) VALUES ('reset-store','reset','op','entry','completed','2026-01-01')"),
    env.DB.prepare("INSERT INTO machine_login_events(id,user_id,card_id,machine_id,risk_result,result) VALUES ('reset-event','reset','reset','reset-machine','allowed','success')"),
    env.DB.prepare("INSERT INTO live_activity_tokens(id,shop_id,user_id,activity_id,token,environment,bundle_id,attributes_json,created_at,updated_at) VALUES ('reset','reset-store','reset','activity','test','sandbox','test','{}','2026-01-01','2026-01-01')"),
    env.DB.prepare("INSERT INTO live_activity_start_tokens(id,user_id,client_id,bundle_id,environment,token,created_at,updated_at,last_seen_at) VALUES ('reset','reset','client','test','sandbox','test','2026-01-01','2026-01-01','2026-01-01')"),
    env.DB.prepare("INSERT INTO asset_definitions(shop_id,type,code,name) VALUES ('reset-store','currency','paid','Balance')"),
    env.DB.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES ('reset-store','holding','p','currency','paid',4200)"),
    env.DB.prepare("INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status,payment_status) VALUES ('reset-store','session','p','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z','closed','paid')"),
    env.DB.prepare("INSERT INTO settlements(shop_id,id,session_id,subtotal,total,status,settled_at) VALUES ('reset-store','settled','session',1800,1800,'settled','2026-01-01T01:00:00Z')"),
  ]);
  const before = await env.DB.prepare("SELECT * FROM settlements WHERE shop_id='reset-store'").all();
  expect(await request("/api/v1/admin/users/reset")).toMatchObject({ status: 200, data: { ok: true } });
  for (const table of ["auth_sessions", "auth_identities", "auth_challenges", "passkeys", "cards", "shop_members", "shop_staff_accounts", "shop_player_accounts", "shop_platform_bindings", "platform_binding_codes", "player_operations", "live_activity_tokens", "live_activity_start_tokens"])
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id='reset'`).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_credentials WHERE identity_id='reset'").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM machine_tickets WHERE token_hash='reset-ticket'").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT created_by FROM shops WHERE id='reset-store'").first("created_by")).toBe("admin");
  expect(await env.DB.prepare("SELECT role FROM shop_members WHERE shop_id='reset-store' AND user_id='admin'").first("role")).toBe("owner");
  expect((await env.DB.prepare("SELECT * FROM settlements WHERE shop_id='reset-store'").all()).results).toEqual(before.results);
  expect(await env.DB.prepare("SELECT quantity FROM asset_holdings WHERE shop_id='reset-store'").first("quantity")).toBe(4200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_identities WHERE shop_id='reset-store'").first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT user_id,card_id,machine_id,result FROM machine_login_events WHERE id='reset-event'").first()).toEqual({ user_id: null, card_id: null, machine_id: "reset-machine", result: "success" });
  expect((await request("/api/v1/me", user, "GET")).data.user).toBeNull();
  expect((await request("/api/v1/cards", user, "GET")).status).toBe(401);
  expect((await request("/api/v1/appclip/auth/exchange", "anonymous", "POST", { code: user })).status).toBe(400);
  const probe = new Hono<AppBindings>();
  probe.post("/register", async c => c.json(await provisionMunetUser(c, { subject: user, name: "Reset user", username: user, cards: [{ luid: "01234567890123456789", remark: "Synced again" }], tokens: { accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 3600 } })));
  const registered = await (await probe.request("/register", { method: "POST" }, env)).json() as { userId: string; isNewUser: boolean };
  expect(registered.isNewUser).toBe(true);
  expect(registered.userId).not.toBe(user);
  expect(await env.DB.prepare("SELECT role FROM users WHERE id=?").bind(registered.userId).first("role")).toBe("user");
  expect(await env.DB.prepare("SELECT access_code FROM cards WHERE user_id=?").bind(registered.userId).first("access_code")).toBe("01234567890123456789");
  expect((await request("/api/v1/cards", user, "GET")).status).toBe(401);
});

test("existing co-owners retain the store and creator reference without granting another owner access", async () => {
  await seedUser("creator"); await seedUser("co-owner");
  await seedShop("co-store", "creator");
  await env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('co-owner','co-store','co-owner','owner')").run();
  expect((await request("/api/v1/admin/users/creator")).status).toBe(200);
  expect(await env.DB.prepare("SELECT created_by FROM shops WHERE id='co-store'").first("created_by")).toBe("co-owner");
  expect(await env.DB.prepare("SELECT user_id,role FROM shop_members WHERE shop_id='co-store'").all()).toMatchObject({ results: [{ user_id: "co-owner", role: "owner" }] });
});

test("a sole owner who was not the creator transfers to the acting administrator, including an existing staff membership", async () => {
  await seedUser("sole-owner");
  await seedShop("sole-store", "regular", "sole-owner");
  await env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('admin-staff','sole-store','admin','staff')").run();
  expect((await request("/api/v1/admin/users/sole-owner")).status).toBe(200);
  expect(await env.DB.prepare("SELECT created_by FROM shops WHERE id='sole-store'").first("created_by")).toBe("regular");
  expect(await env.DB.prepare("SELECT id,user_id,role FROM shop_members WHERE shop_id='sole-store'").all()).toMatchObject({ results: [{ id: "admin-staff", user_id: "admin", role: "owner" }] });
});

test("a failed deletion rolls back credential cleanup and store ownership together", async () => {
  await seedUser("rollback"); await seedShop("rollback-store", "rollback");
  await env.DB.prepare("CREATE TRIGGER fail_account_delete BEFORE DELETE ON users WHEN OLD.id='rollback' BEGIN SELECT RAISE(ABORT,'test failure'); END").run();
  try {
    expect((await request("/api/v1/admin/users/rollback")).status).toBe(500);
    for (const table of ["auth_sessions", "auth_identities", "auth_challenges", "passkeys", "cards"])
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id='rollback'`).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT created_by FROM shops WHERE id='rollback-store'").first("created_by")).toBe("rollback");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_members WHERE shop_id='rollback-store' AND user_id='admin'").first("n")).toBe(0);
    expect((await request("/api/v1/cards", "rollback", "GET")).status).toBe(200);
  } finally { await env.DB.prepare("DROP TRIGGER fail_account_delete").run(); }
});

test("concurrent administrators cannot delete each other from stale authenticated requests", async () => {
  await seedUser("admin-a", "admin"); await seedUser("admin-b", "admin");
  const results = await Promise.all([request("/api/v1/admin/users/admin-b", "admin-a"), request("/api/v1/admin/users/admin-a", "admin-b")]);
  expect(results.filter(r => r.status === 200)).toHaveLength(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id IN ('admin-a','admin-b')").first("n")).toBe(1);
});
