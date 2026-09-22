import { afterAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { sqliteSchema } from "@prism/storage-sql";
import { createD1Repositories } from "@prism/adapter-d1";
import { createPrismWorkerDependencies } from "@prism/runtime";
import { activityBill } from "../src/live-activity-billing";

const build = await Bun.build({ entrypoints: [new URL("../src/live-billing-object.ts", import.meta.url).pathname], target: "browser", external: ["cloudflare:workers", "node:*", "bun:sqlite"] });
if (!build.success) throw new Error(build.logs.join("\n"));
const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
const privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----`;
const pushes: Record<string, any>[] = [];
let failures = 0;
const mf = new Miniflare({ modules: true, script: await build.outputs[0]!.text(), compatibilityDate: "2026-06-07", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"], kvNamespaces: ["RATE_LIMIT"],
  durableObjects: { LIVE_BILLING: { className: "LiveBilling", useSQLite: true } },
  bindings: { APNS_KEY_ID: "TEST", APNS_TEAM_ID: "TEST", APNS_PRIVATE_KEY: privateKey },
  outboundService: async request => {
    if (!new URL(request.url).hostname.endsWith("push.apple.com")) throw new Error("Unexpected outbound request");
    pushes.push(await request.json() as Record<string, any>);
    if (failures > 0) { failures--; return new Response("temporary", { status: 500 }); }
    return new Response("", { status: 200 });
  },
});
afterAll(() => mf.dispose());

test("real DO alarms push authoritative bills, deduplicate and end with the persisted checkout", async () => {
  const db = await mf.getD1Database("DB");
  for (const sql of sqliteSchema) await db.prepare(sql).run();
  const root = new URL("../../../migrations/", import.meta.url);
  for (const file of readdirSync(root).filter(file => file >= "0017_" && file < "0027_" && file.endsWith(".sql")).sort()) {
    for (const sql of readFileSync(new URL(file, root), "utf8").replace(/^\s*--.*$/gm, "").split(";").map(sql => sql.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  const now = new Date();
  await db.prepare("INSERT INTO users(id,role) VALUES('u','user')").run();
  await db.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES('shop','shop','Shop',0,0,80,'u')").run();
  await db.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop','p','Player','active',?)").bind(now.toISOString()).run();
  await db.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES('shop','u','p','123456',?)").bind(now.toISOString()).run();
  await db.prepare("INSERT INTO asset_definitions(shop_id,type,code,name,stackable) VALUES('shop','currency','balance','Balance',1)").run();
  await db.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES('shop','wallet','p','currency','balance',100000)").run();
  const repos = createD1Repositories({ db, shopId: "shop", now: () => now, id: crypto.randomUUID });
  await repos.pricingConfigs.save({ id: "rate", kind: "time.priority", name: "标准方案", enabled: true, createdAt: now, updatedAt: now,
    provider: { id: "provider", rules: [{ id: "day", label: "日间", priority: 1, dateTimeRange: { start: new Date(+now - 3600_000), end: new Date(+now + 3600_000) }, pricing: { unitMinutes: 30, unitPrice: 6, roundGraceMinutes: 29, priceCap: 100 } }] } });
  await repos.sessions.save({ id: "entry", playerId: "p", status: "active", paymentStatus: "unpaid", startedAt: new Date(+now - 40 * 60_000), pricingConfigIds: ["rate"] });
  await repos.sessions.save({ id: "extra", playerId: "p", status: "active", paymentStatus: "unpaid", startedAt: new Date(+now - 25 * 60_000), pricingConfigIds: ["rate"] });
  const env = { DB: db } as Parameters<typeof activityBill>[0];
  const initial = await activityBill(env, "shop", "p", now);
  expect(initial?.bill.amountCents).toBe(600);
  expect(initial?.bill.nextChargeAtUnix).toBe((+now + 5 * 60_000) / 1000);
  expect(initial?.bill.nextRuleAtUnix).toBe((+now + 3600_000) / 1000);
  expect(initial?.bill.planLabel).toBe("标准方案（日间）");
  await repos.pricingConfigs.save({ id: "cap", kind: "time.cap", name: "全局封顶", enabled: true, createdAt: now, updatedAt: now,
    provider: { id: "cap", includedPricingConfigIds: ["rate"], rules: [{ id: "cap-day", label: "日间", priority: 1, dateTimeRange: { start: new Date(+now - 3600_000), end: new Date(+now + 3600_000) }, priceCap: 6 }] } });
  await db.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop','capped','Capped','active',?)").bind(now.toISOString()).run();
  await repos.sessions.save({ id: "capped-visit", playerId: "capped", status: "active", paymentStatus: "unpaid", startedAt: new Date(+now - 40 * 60_000), pricingConfigIds: ["rate"] });
  const capped = await activityBill(env, "shop", "capped", now);
  expect(capped?.bill.amountCents).toBe(600);
  expect(capped?.bill.nextChargeAtUnix).toBeNull();
  expect(capped?.bill.nextRuleAtUnix).toBe((+now + 3600_000) / 1000);
  await db.prepare(`INSERT INTO live_activity_tokens(id,shop_id,user_id,activity_id,token,environment,bundle_id,session_id,attributes_json,created_at,updated_at)
    VALUES('token','shop','u','activity',?,'sandbox','moe.neri.hinatago','entry','{}',?,?)`).bind("a".repeat(64), now.toISOString(), now.toISOString()).run();
  const namespace = await mf.getDurableObjectNamespace("LIVE_BILLING");
  const stub = namespace.get(namespace.idFromName(JSON.stringify(["shop", "p"])));
  // The production RPC runs inside workerd, including persistent alarm delivery.
  await (stub as any).refresh("shop", "p");
  const waitPush = async (count: number) => {
    const deadline = Date.now() + 5000;
    while (pushes.length < count && Date.now() < deadline) await Bun.sleep(50);
    expect(pushes.length).toBe(count);
  };
  await waitPush(1);
  expect(pushes[0]!.aps.event).toBe("update");
  expect(pushes[0]!.aps["content-state"].bill.amountCents).toBe(600);
  expect(new TextEncoder().encode(JSON.stringify(pushes[0])).length).toBeLessThan(4096);
  await (stub as any).refresh("shop", "p");
  await Bun.sleep(1300);
  expect(pushes.length).toBe(1);

  // Device activity cancels free grace. A transient APNs failure must retry this new bill.
  await db.prepare("UPDATE sessions SET metadata_json='{\"deviceOperated\":true}' WHERE id='extra'").run();
  failures = 1;
  await (stub as any).refresh("shop", "p");
  await waitPush(3);
  expect(pushes[2]!.aps["content-state"].bill.amountCents).toBe(1200);

  for (const session of await repos.sessions.findActiveByPlayerId("p")) {
    await repos.sessions.save({ ...session, status: "closed", endedAt: new Date() });
  }
  await (stub as any).refresh("shop", "p");
  await waitPush(4);
  expect(pushes[3]!.aps.event).toBe("update");
  expect(pushes[3]!.aps["content-state"].endedAtUnix).toBeNumber();
  expect(pushes[3]!.aps["content-state"].bill.nextChargeAtUnix).toBeNull();

  const checkout = await createPrismWorkerDependencies({ DB: db }, { shopId: "shop" }).playerCheckoutCommands!.checkout({ playerId: "p", closeSessionsBeforeBalanceCheck: false });
  await (stub as any).refresh("shop", "p");
  await waitPush(5);
  expect(pushes[4]!.aps.event).toBe("end");
  expect(pushes[4]!.aps["content-state"].bill.amountCents).toBe(checkout.playerSettlement.total);
  expect((await db.prepare("SELECT id FROM live_activity_tokens").all()).results).toHaveLength(0);
}, 20000);
