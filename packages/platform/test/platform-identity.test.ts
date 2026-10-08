import { beforeEach } from "bun:test";
import { createTestRateLimits } from "./rate-limit-fixture";
const rateLimits = createTestRateLimits();
beforeEach(rateLimits.reset);
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import app from "../src/index";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";

const mf = new Miniflare({ modules:true,script:"export default {fetch(){return new Response('test')}}",d1Databases:["DB"],compatibilityDate:"2026-06-07" });
let env:Env;
const origin = "https://identity.test";
async function request(path:string,body?:unknown,user="owner",method=body===undefined ? "GET" : "POST",bot=false) {
  const response = await app.fetch(new Request(origin+path,{method,headers:{origin,"content-type":"application/json",cookie:`arcadelink_session=${user}-token`,
    ...(bot ? {authorization:"Bearer integration-token"} : {})},...(body===undefined ? {} : {body:JSON.stringify(body)})}),env);
  return {status:response.status,...await response.json() as {data?:any;error?:{code:string}}};
}
const op = () => crypto.randomUUID();
async function shop() {
  const result = await request("/api/v1/merchant/shops",{name:"Identity store",latitude:35,longitude:139,billingSetup:{paidName:"余额",freeName:"赠送余额",hourlyPrice:18,graceMinutes:10,dailyCap:90,autoRegister:true}});
  expect(result.status).toBe(201);
  const shop = result.data.shop as {id:string;publicId:string};
  await env.DB.prepare("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES (?,'bot','Bot','integration','test',?,'active','2026-01-01')")
    .bind(shop.id,createHash("sha256").update("integration-token").digest("hex")).run();
  return shop;
}
async function bind(code:string,provider:string,subject:string,user="u1") {
  const generated = await request(`/api/v1/shops/${code}/platform-binding`,{},user);
  expect(generated.status).toBe(200);
  return request(`/api/v1/shops/${code}/integration/platform-binding/confirm`,{code:generated.data.code,provider,subject},user,"POST",true);
}
async function seedPlayer(shopId:string,id:string,provider:string,subject:string,user?:string) {
  await env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,?,?,'active','2026-01-01')").bind(shopId,id,id).run();
  await env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,?,?,?,'2026-01-01')").bind(shopId,id,provider,subject).run();
  if (user) await env.DB.batch([
    env.DB.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES (?,?,?,'2026-01-01')").bind(shopId,user,id),
    env.DB.prepare("INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at) VALUES (?,?,?,?,'2026-01-01')").bind(shopId,user,provider,subject),
  ]);
}
beforeAll(async()=>{
  env={DB:await mf.getD1Database("DB"),...rateLimits.bindings,APP_ORIGIN:origin,SESSION_SECRET:"test",URL_ENCRYPTION_KEY:"test",MUNET_CLIENT_ID:"",MUNET_CLIENT_SECRET:"",APPLE_TEAM_ID:"TEST"} as Env;
  for (const sql of sqliteSchema) await env.DB.prepare(sql).run();
  for (const name of ["0017_platform_accounts","0018_unified_devices","0019_ticket_coin","0020_mahjong_devices","0021_machine_aliases","0023_remote_entry","0024_drop_remote_entry"])
    for (const sql of readFileSync(new URL(`../../../migrations/${name}.sql`,import.meta.url),"utf8").replace(/^\s*--.*$/gm,"").split(";").filter(s=>s.trim())) await env.DB.prepare(sql).run();
  for (const user of ["owner","viewer","u1","u2","u3"]) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,role) VALUES (?,'user')").bind(user),
      env.DB.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_subject,display_name) VALUES (?,?,'munet',?,?)").bind(user,user,user,user),
      env.DB.prepare("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES (?,?,?,'2999-01-01')").bind(user,user,await sha256(`${user}-token`)),
    ]);
  }
  await env.DB.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,created_by) VALUES ('legacy','legacy','Legacy',0,0,'owner')").run();
  await env.DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('legacy','old','Original','active','2026-01-01')").run();
  await env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('legacy','old','qq','114514','2026-01-01')").run();
  await env.DB.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES ('legacy','u1','old','114514','2026-01-01')").run();
  await env.DB.prepare("INSERT INTO qq_binding_codes(shop_id,user_id,code_hash,expires_at,created_at) VALUES ('legacy','u2','old-code','2999-01-01','2026-01-01')").run();
  const migration=splitD1MigrationStatements(readFileSync(new URL("../../../migrations/0030_platform_identity_bindings.sql",import.meta.url),"utf8"));
  await env.DB.batch(migration.map(sql=>env.DB.prepare(sql)));
},30000);
afterAll(()=>mf.dispose());

test("schema upgrade preserves legacy identifiers and account/player links until the owner converts them",async()=>{
  expect(await env.DB.prepare("SELECT player_id,verified_at FROM shop_player_accounts WHERE shop_id='legacy'").first()).toEqual({player_id:"old",verified_at:"2026-01-01"});
  expect(await env.DB.prepare("SELECT provider,subject FROM shop_platform_bindings WHERE shop_id='legacy'").first()).toEqual({provider:"qq",subject:"114514"});
  expect(await env.DB.prepare("SELECT provider,subject FROM player_identities WHERE shop_id='legacy'").first()).toEqual({provider:"qq",subject:"114514"});
  expect(await env.DB.prepare("SELECT code_hash FROM platform_binding_codes WHERE shop_id='legacy'").first("code_hash")).toBe("old-code");
});

test("onebot and telegram with the same subject remain different people, and either binding satisfies admission",async()=>{
  const store=await shop();
  const first=await bind(store.publicId,"onebot","114514");
  const other=await bind(store.publicId,"telegram","114514","u2");
  expect(first.status).toBe(200);expect(other.status).toBe(200);
  expect(first.data.playerId).not.toBe(other.data.playerId);
  // Adding another adapter to the same account attaches it to the same player, never another wallet.
  const second=await bind(store.publicId,"telegram","tg-u1");
  expect(second.status).toBe(200);expect(second.data.playerId).toBe(first.data.playerId);
  expect((await request(`/api/v1/shops/${store.publicId}/platform-binding`,undefined,"u1")).data.bindings).toHaveLength(2);
  const machine=await request("/api/v1/merchant/machines",{shopId:store.id,name:"Game",hinataUrl:"http://192.168.1.99"});
  expect(machine.status).toBe(201);
  for (const user of ["u1","u2","u3"]) {
    const session=await request("/api/v1/machines/session/start",{shopCode:store.publicId,publicId:machine.data.machine.publicId},user);
    const state=await request(`/api/v1/devices/session/state?ticket=${session.data.ticket}`,undefined,user);
    expect(state.data.gate).toBe(user==="u3" ? "binding" : "entry");
    const entry=await request(`/api/v1/shops/${store.publicId}/player/session/start`,{ticket:session.data.ticket,consent:true,operationId:op()},user);
    expect(entry.status).toBe(user==="u3" ? 403 : 200);
    if(user==="u3") expect(entry.error?.code).toBe("PLATFORM_BINDING_REQUIRED");
  }
});

test("optional binding creates one web player, supports later linking, and preserves checkout if binding becomes mandatory",async()=>{
  const store=await shop();
  const settings=await request(`/api/v1/shops/${store.publicId}/settings`);
  expect(settings.data.identityBindingRequired).toBe(true);
  expect((await request(`/api/v1/shops/${store.publicId}/settings`,{...settings.data,identityBindingRequired:false},"owner","PUT")).status).toBe(200);
  const summary=await request(`/api/v1/shops/${store.publicId}/player/me`,undefined,"u1");
  expect(summary.status).toBe(200);
  await Promise.all([request(`/api/v1/shops/${store.publicId}/player/me`,undefined,"u1"),request(`/api/v1/shops/${store.publicId}/player/me`,undefined,"u1")]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE shop_id=?").bind(store.id).first("n")).toBe(1);
  const existing=await env.DB.prepare("SELECT player_id FROM shop_player_accounts WHERE shop_id=? AND user_id='u1'").bind(store.id).first<string>("player_id");
  const machine=await request("/api/v1/merchant/machines",{shopId:store.id,name:"Game",hinataUrl:"http://192.168.1.99"});
  const session=await request("/api/v1/machines/session/start",{shopCode:store.publicId,publicId:machine.data.machine.publicId},"u1");
  expect((await request(`/api/v1/devices/session/state?ticket=${session.data.ticket}`,undefined,"u1")).data.gate).toBe("entry");
  expect((await request(`/api/v1/shops/${store.publicId}/player/session/start`,{ticket:session.data.ticket,consent:true,operationId:op()},"u1")).status).toBe(200);
  expect((await request(`/api/v1/shops/${store.publicId}/settings`,settings.data,"owner","PUT")).status).toBe(200);
  expect((await request(`/api/v1/shops/${store.publicId}/player/me`,undefined,"u1")).status).toBe(200);
  expect((await request(`/api/v1/shops/${store.publicId}/player/checkout/confirm`,{operationId:op()},"u1")).status).toBe(200);
  expect((await request(`/api/v1/devices/session/state?ticket=${session.data.ticket}`,undefined,"u1")).data.gate).toBe("binding");
  const linked=await bind(store.publicId,"telegram","opaque-user-id");
  expect(linked.status).toBe(200);expect(linked.data.playerId).toBe(existing);
});

test("owner conversion preserves wallets and visits, updates both identity tables, and replays safely",async()=>{
  const store=await shop();
  await seedPlayer(store.id,"original","qq","114514","u1");
  await seedPlayer(store.id,"bot-only","qq","bot-only");
  await env.DB.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES (?,'wallet','original','currency','paid',12345)").bind(store.id).run();
  const machine=await request("/api/v1/merchant/machines",{shopId:store.id,name:"Entry"});
  const session=await request("/api/v1/machines/session/start",{shopCode:store.publicId,publicId:machine.data.machine.publicId},"u1");
  expect((await request(`/api/v1/shops/${store.publicId}/player/session/start`,{ticket:session.data.ticket,consent:true,operationId:op()},"u1")).status).toBe(200);
  const visitBefore=(await env.DB.prepare("SELECT * FROM sessions WHERE shop_id=?").bind(store.id).all()).results;
  const base=`/api/v1/shops/${store.publicId}/identity-conversion`;
  const body={sourceProvider:"qq",targetProvider:"onebot"};
  const preview=await request(`${base}/preview`,body);
  expect(preview.status).toBe(200);expect(preview.data).toMatchObject({playerCount:2,identityCount:2,bindingCount:1,conflicts:[]});
  expect(await env.DB.prepare("SELECT provider FROM shop_platform_bindings WHERE shop_id=?").bind(store.id).first("provider")).toBe("qq");
  const apply={...body,fingerprint:preview.data.fingerprint,operationId:op()};
  expect((await request(`${base}/apply`,apply)).status).toBe(200);
  expect((await request(`${base}/apply`,apply)).data.converted).toBe(true);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_identities WHERE shop_id=? AND provider='qq'").bind(store.id).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT player_id FROM player_identities WHERE shop_id=? AND provider='onebot' AND subject='114514'").bind(store.id).first("player_id")).toBe("original");
  expect(await env.DB.prepare("SELECT quantity FROM asset_holdings WHERE shop_id=? AND player_id='original'").bind(store.id).first("quantity")).toBe(12345);
  expect(await env.DB.prepare("SELECT provider,subject FROM shop_platform_bindings WHERE shop_id=?").bind(store.id).first()).toEqual({provider:"onebot",subject:"114514"});
  expect((await env.DB.prepare("SELECT * FROM sessions WHERE shop_id=?").bind(store.id).all()).results).toEqual(visitBefore);
  expect((await request(`${base}/preview`,body)).data.playerCount).toBe(0);
});

test("conversion refuses conflicting players, stale previews and non-owner requests without changing identities",async()=>{
  const store=await shop();
  await seedPlayer(store.id,"old","legacy","same","u1");
  await seedPlayer(store.id,"other","telegram","same","u2");
  const base=`/api/v1/shops/${store.publicId}/identity-conversion`;
  const body={sourceProvider:"legacy",targetProvider:"telegram"};
  const preview=await request(`${base}/preview`,body);
  expect(preview.data.conflicts.length).toBeGreaterThan(0);
  expect((await request(`${base}/apply`,{...body,fingerprint:preview.data.fingerprint,operationId:op()})).error?.code).toBe("IDENTITY_CONVERSION_CONFLICT");
  expect(await env.DB.prepare("SELECT provider FROM shop_platform_bindings WHERE shop_id=? AND user_id='u1'").bind(store.id).first("provider")).toBe("legacy");
  expect((await request(`${base}/preview`,body,"u1")).status).toBe(403);
  await env.DB.prepare("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('viewer-identity',?,'viewer','viewer')").bind(store.id).run();
  expect((await request(`${base}/preview`,body,"viewer")).status).toBe(403);
  const clean={sourceProvider:"legacy",targetProvider:"onebot"};
  const before=await request(`${base}/preview`,clean);
  await seedPlayer(store.id,"new","legacy","new");
  expect((await request(`${base}/apply`,{...clean,fingerprint:before.data.fingerprint,operationId:op()})).error?.code).toBe("IDENTITY_CONVERSION_STALE");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_identities WHERE shop_id=? AND provider='onebot'").bind(store.id).first("n")).toBe(0);
});

test("conversion rolls back identity and binding writes together if the database rejects the batch",async()=>{
  const store=await shop();
  await seedPlayer(store.id,"rollback","legacy","rollback","u1");
  const base=`/api/v1/shops/${store.publicId}/identity-conversion`;
  const body={sourceProvider:"legacy",targetProvider:"onebot"};
  const preview=await request(`${base}/preview`,body);
  await env.DB.prepare(`CREATE TRIGGER reject_identity_conversion BEFORE UPDATE OF provider ON shop_platform_bindings
    WHEN NEW.subject='rollback' BEGIN SELECT RAISE(ABORT,'injected conversion failure'); END`).run();
  try {
    expect((await request(`${base}/apply`,{...body,fingerprint:preview.data.fingerprint,operationId:op()})).status).toBe(500);
    expect(await env.DB.prepare("SELECT provider FROM player_identities WHERE shop_id=?").bind(store.id).first("provider")).toBe("legacy");
    expect(await env.DB.prepare("SELECT provider FROM shop_platform_bindings WHERE shop_id=?").bind(store.id).first("provider")).toBe("legacy");
  } finally { await env.DB.prepare("DROP TRIGGER reject_identity_conversion").run(); }
});

test("conversion deduplicates matching target identities owned by the same player",async()=>{
  const store=await shop();
  await seedPlayer(store.id,"same","legacy","same","u1");
  await env.DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'same','onebot','same','2026-01-01')").bind(store.id).run();
  await env.DB.prepare("INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at) VALUES (?,'u1','onebot','same','2026-01-01')").bind(store.id).run();
  const body={sourceProvider:"legacy",targetProvider:"onebot"};
  const base=`/api/v1/shops/${store.publicId}/identity-conversion`;
  const preview=await request(`${base}/preview`,body);
  expect(preview.data.conflicts).toEqual([]);
  expect((await request(`${base}/apply`,{...body,fingerprint:preview.data.fingerprint,operationId:op()})).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_identities WHERE shop_id=?").bind(store.id).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_platform_bindings WHERE shop_id=?").bind(store.id).first("n")).toBe(1);
});
