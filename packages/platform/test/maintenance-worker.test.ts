import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/crypto";

async function workerOptions(phase: "maintenance" | "verify" | "live") {
  const file = phase === "maintenance" ? "maintenance-worker.ts" : "worker.ts";
  const build = await Bun.build({ entrypoints: [new URL(`../src/${file}`, import.meta.url).pathname], target: "browser", external: ["cloudflare:workers", "node:*", "bun:sqlite"] });
  if (!build.success) throw new Error(build.logs.join("\n"));
  return { modules: true, script: await build.outputs[0]!.text(), compatibilityDate: "2026-06-07", compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"], durableObjects: { LIVE_BILLING: { className: "LiveBilling", useSQLite: true } },
    bindings: { APP_ORIGIN: "https://test", PRISM_DEPLOY_GUARD: "1", PRISM_DEPLOY_PHASE: phase, PRISM_DEPLOY_TOKEN_HASH: await sha256("a".repeat(64)), PRISM_DEPLOY_REVISION: "test-revision" } };
}
async function worker(phase: "maintenance" | "verify" | "live") {
  return new Miniflare(await workerOptions(phase));
}

test("the standalone maintenance worker serves 503 before any business schema exists", async () => {
  const mf = await worker("maintenance");
  try {
    for (const path of ["/merchant", "/assets/index.js", "/api/v1/health", "/api/v1/shops/store/platform-binding", "/callback", "/t/shop/device"]) {
      const response = await mf.dispatchFetch(`https://test${path}`);
      expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("30");
    }
    const response = await mf.dispatchFetch("https://test/__prism_deploy", { method: "POST", headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" }, body: JSON.stringify({ action: "begin" }) });
    expect(response.status).toBe(200);
    expect((await response.json() as any).revision).toBe("test-revision");
    const db = await mf.getD1Database("DB");
    expect(await db.prepare("SELECT maintenance FROM prism_deployment_gate").first("maintenance")).toBe(1);
    expect((await db.prepare("SELECT name FROM sqlite_master WHERE name='users'").all()).results).toHaveLength(0);
  } finally { await mf.dispose(); }
}, 30000);

test("the actual normal worker fails closed with missing control state, including health and static paths", async () => {
  const mf = await worker("live");
  try {
    for (const path of ["/api/v1/health", "/merchant", "/assets/index.js"]) expect((await mf.dispatchFetch(`https://test${path}`)).status).toBe(503);
    expect((await mf.dispatchFetch("https://test/__prism_deploy", { method: "POST", body: "{}" })).status).toBe(404);
  } finally { await mf.dispose(); }
}, 30000);

test("maintenance and normal LiveBilling alarms preserve pending visits and defer without touching the business schema", async () => {
  for (const file of ["maintenance-worker.ts", "live-billing-object.ts"]) {
    const path = new URL(`../src/${file}`, import.meta.url).pathname;
    const build = await Bun.build({ entrypoints: [path], target: "browser", external: ["cloudflare:workers", "node:*", "bun:sqlite"],
      plugins: [{ name: "inspect-actual-alarm", setup(builder) {
        builder.onLoad({ filter: new RegExp(file.replaceAll(".", "\\.") + "$") }, args => ({ loader: "ts", contents: readFileSync(args.path, "utf8") + `
          export class InspectLiveBilling extends LiveBilling {
            async exercise() {
              await this.ctx.storage.put('visit', {shopId:'shop',playerId:'player',revision:1});
              await this.ctx.storage.setAlarm(Date.now()+60000);
              await this.alarm();
              return {visit:await this.ctx.storage.get('visit'),next:await this.ctx.storage.getAlarm()};
            }
          }` }));
      } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const mf = new Miniflare({ modules: true, script: await build.outputs[0]!.text(), compatibilityDate: "2026-06-07", compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"], durableObjects: { INSPECT: { className: "InspectLiveBilling", useSQLite: true } },
      bindings: { PRISM_DEPLOY_GUARD: "1", PRISM_DEPLOY_PHASE: "verify", APNS_KEY_ID: "TEST", APNS_TEAM_ID: "TEST", APNS_PRIVATE_KEY: "TEST" },
      outboundService: async () => { throw new Error("Maintenance must not push to APNs"); },
    });
    try {
      const ns = await mf.getDurableObjectNamespace("INSPECT");
      const state = await (ns.get(ns.idFromName("visit")) as any).exercise();
      expect(state.visit).toEqual({ shopId: "shop", playerId: "player", revision: 1 });
      expect(state.next).toBeGreaterThan(Date.now() + 20_000);
    } finally { await mf.dispose(); }
  }
}, 30000);

test("real maintenance -> verify -> live worker rollout migrates a fresh D1, stays closed until verification and reports the new public revision", async () => {
  const folder = mkdtempSync(join(tmpdir(), "prism-deployment-test-"));
  const persistence = { d1Persist: join(folder, "d1"), durableObjectsPersist: join(folder, "do") };
  let mf = new Miniflare({ ...await workerOptions("maintenance"), ...persistence });
  async function control(body: Record<string, unknown>) {
    return mf.dispatchFetch("https://test/__prism_deploy", { method: "POST", headers: { authorization: `Bearer ${"a".repeat(64)}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  try {
    expect((await control({ action: "begin" })).status).toBe(200);
    const root = new URL("../../../migrations/", import.meta.url);
    for (const name of readdirSync(root).filter(name => name.endsWith(".sql")).sort()) {
      const response = await control({ action: "schema", name, sql: readFileSync(new URL(name, root), "utf8") });
      expect(response.status, name).toBe(200);
    }
    await mf.dispose();
    mf = new Miniflare({ ...await workerOptions("verify"), ...persistence });
    expect((await mf.dispatchFetch("https://test/api/v1/health")).status).toBe(503);
    expect((await control({ action: "convert" })).status).toBe(200);
    expect((await control({ action: "check" })).status).toBe(200);
    await mf.dispose();
    mf = new Miniflare({ ...await workerOptions("live"), ...persistence });
    expect((await mf.dispatchFetch("https://test/api/v1/health")).status).toBe(503);
    expect((await control({ action: "resume" })).status).toBe(200);
    const response = await mf.dispatchFetch("https://test/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-prism-revision")).toBe("test-revision");
    expect((await response.json() as any).data.ok).toBe(true);
    expect((await control({ action: "block" })).status).toBe(200);
    expect((await mf.dispatchFetch("https://test/api/v1/health")).status).toBe(503);
  } finally { await mf.dispose(); rmSync(folder, { recursive: true, force: true }); }
}, 30000);
