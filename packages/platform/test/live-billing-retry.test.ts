import { afterAll, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";

// Inspect real DO storage without adding production RPCs. The cached bill deliberately
// avoids creating pricing tables: retries must reuse it rather than recompute billing.
const path = new URL("../src/live-billing-object.ts", import.meta.url).pathname;
const build = await Bun.build({ entrypoints: [path], target: "browser", external: ["cloudflare:workers", "node:*", "bun:sqlite"],
  plugins: [{ name: "inspect-retry", setup(builder) {
    builder.onLoad({ filter: /live-billing-object\.ts$/ }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8") + `
      export class InspectLiveBilling extends LiveBilling {
        async exercise(force = false, end = false) {
          const now = Date.now();
          if (!await this.ctx.storage.get('visit')) {
            await this.ctx.storage.put('visit', {shopId:'s',playerId:'p',revision:1});
            await this.ctx.storage.put('bill', {revision:1,calculatedAt:now,snapshot:{bill:{amountCents:600,planLabel:'test',nextEvent:null,asOfUnix:now/1000},nextCheckAt:null}});
          }
          if (end) await this.ctx.storage.put('bill', {revision:1,calculatedAt:now,snapshot:null});
          const retry = await this.ctx.storage.get('retry:bad');
          if (force && retry) await this.ctx.storage.put('retry:bad', {...retry,nextAt:now-1});
          await this.alarm();
          return {retry:await this.ctx.storage.get('retry:bad'),next:await this.ctx.storage.getAlarm()};
        }
      }` }));
  } }],
});
if (!build.success) throw new Error(build.logs.join("\n"));
const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
const pushes: string[] = [];
const mf = new Miniflare({ modules: true, script: await build.outputs[0]!.text(), compatibilityDate: "2026-06-07", compatibilityFlags: ["nodejs_compat"],
  d1Databases: ["DB"], durableObjects: { RETRY: { className: "InspectLiveBilling", useSQLite: true } },
  bindings: { APNS_KEY_ID: "TEST", APNS_TEAM_ID: "TEST", APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----` },
  outboundService: async request => {
    const token = new URL(request.url).pathname.split("/").at(-1)!;
    pushes.push(token); return new Response("", { status: token.startsWith("a") ? 500 : 200 });
  },
});
afterAll(() => mf.dispose());
test("one failed token schedules bounded retries while healthy delivery is deduplicated", async () => {
  const db = await mf.getD1Database("DB");
  for (const sql of [
    "CREATE TABLE live_activity_tokens(id TEXT,token TEXT,environment TEXT,bundle_id TEXT,session_id TEXT,created_at TEXT,shop_id TEXT,user_id TEXT)",
    "CREATE TABLE shop_player_accounts(shop_id TEXT,user_id TEXT,player_id TEXT)",
    "CREATE TABLE sessions(shop_id TEXT,id TEXT,player_id TEXT,started_at TEXT,ended_at TEXT,payment_status TEXT)",
    "CREATE TABLE settlements(shop_id TEXT,session_id TEXT,checkout_id TEXT)",
    "CREATE TABLE player_checkouts(shop_id TEXT,id TEXT,total INTEGER,settled_at TEXT)",
    "INSERT INTO shop_player_accounts VALUES ('s','u','p')",
  ]) await db.prepare(sql).run();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO sessions VALUES ('s','visit','p',?,NULL,'unpaid')").bind(now).run();
  for (const [id, token] of [["bad", "a".repeat(64)], ["good", "b".repeat(64)]])
    await db.prepare("INSERT INTO live_activity_tokens VALUES (?,?,'sandbox','moe.neri.hinatago','visit',?,'s','u')").bind(id, token, now).run();
  const ns = await mf.getDurableObjectNamespace("RETRY");
  const stub = ns.get(ns.idFromName("retry")) as any;
  const first = await stub.exercise();
  expect(first.retry.failures).toBe(1);
  expect(first.next).toBeGreaterThan(Date.now() + 3000);
  expect(pushes).toHaveLength(2);
  await stub.exercise();
  expect(pushes).toHaveLength(2);
  for (let n = 2; n <= 6; n++) expect((await stub.exercise(true)).retry.failures).toBe(n);
  await stub.exercise(true);
  expect(pushes.filter(t => t.startsWith("a"))).toHaveLength(6);
  expect(pushes.filter(t => t.startsWith("b"))).toHaveLength(1);
  // A failed end is a new signature and remains scheduled even with no active bill.
  const ended = await stub.exercise(false, true);
  expect(ended.retry.failures).toBe(1);
  expect(ended.next).toBeGreaterThan(Date.now() + 3000);
}, 30000);
