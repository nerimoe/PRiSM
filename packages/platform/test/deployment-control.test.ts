import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { deploymentControl } from "../src/deployment-control";
import { deploymentBatch, isDeploymentMaintenance, maintenanceResponse } from "../src/deployment-gate";
import { sha256 } from "../src/crypto";
import type { Env } from "../src/types";

const token = "a".repeat(64), otherToken = "b".repeat(64);
const root = new URL("../../../migrations/", import.meta.url);
const health = async () => Response.json({ data: { ok: true } });
async function fixture() {
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DB"], compatibilityDate: "2026-06-07" });
  const DB = await mf.getD1Database("DB") as unknown as D1Database;
  for (const name of readdirSync(root).filter(name => name.endsWith(".sql") && parseInt(name) < 29).sort())
    await DB.batch(splitD1MigrationStatements(readFileSync(new URL(name, root), "utf8")).map(sql => DB.prepare(sql)));
  await DB.batch([
    DB.prepare("INSERT INTO users(id,role) VALUES('owner','user')"),
    DB.prepare("INSERT INTO shops(id,public_id,name,latitude,longitude,created_by) VALUES('shop','shop','Shop',31.23,121.47,'owner')"),
    DB.prepare("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('shop','player','Player','active','2026-10-02T02:00:00Z')"),
    DB.prepare("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES('shop','player','qq','114514','2026-10-02T02:00:00Z')"),
    DB.prepare("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,qq,verified_at) VALUES('shop','owner','player','114514','2026-10-02T02:00:00Z')"),
    DB.prepare("INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES('shop','store.profile','{\"timeZone\":\"Asia/Shanghai\"}','2026-10-02T02:00:00Z')"),
    DB.prepare(`INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
      VALUES('shop','rate','time.priority','Rate',1,'active',?,'2026-10-02T02:00:00Z','2026-10-02T02:00:00Z')`)
      .bind(JSON.stringify({ id: "rate", rules: [{ id: "base", label: "Base", priority: 1, timeRange: { start: "11:00", end: "03:00" }, pricing: { unitMinutes: 60, unitPrice: 1800 } }] })),
    DB.prepare("INSERT INTO asset_definitions(shop_id,type,code,name) VALUES('shop','currency','paid','Balance')"),
    DB.prepare("INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES('shop','wallet','player','currency','paid',10000)"),
  ]);
  const env = { DB, PRISM_DEPLOY_GUARD: "1", PRISM_DEPLOY_PHASE: "maintenance", PRISM_DEPLOY_TOKEN_HASH: await sha256(token), PRISM_DEPLOY_REVISION: "new-revision" } as Env;
  async function control(body: Record<string, unknown>, auth = token, check = health) {
    return (await deploymentControl(new Request("https://test/__prism_deploy", {
      method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }), env, check))!;
  }
  async function schema() {
    for (const name of ["0029_cashier.sql", "0029_utc_pricing.sql", "0030_platform_identity_bindings.sql"])
      expect((await control({ action: "schema", name, sql: readFileSync(new URL(name, root), "utf8") })).status).toBe(200);
  }
  return { mf, env, DB, control, schema };
}

test("first deployment on the exact stable schema fences existing writers, upgrades atomically and resumes only after verification", async () => {
  const { mf, env, DB, control, schema } = await fixture();
  try {
    expect((await control({ action: "begin" }, otherToken)).status).toBe(404);
    expect((await control({ action: "begin" })).status).toBe(200);
    await expect(DB.prepare("UPDATE pricing_configs SET name='Old write'").run()).rejects.toThrow("PRISM_MAINTENANCE");
    await expect(DB.prepare("UPDATE asset_holdings SET quantity=0").run()).rejects.toThrow("PRISM_MAINTENANCE");
    await schema();
    // Rebuilding membership must not remove its write fence.
    await expect(DB.prepare("DELETE FROM shop_player_accounts").run()).rejects.toThrow("PRISM_MAINTENANCE");
    expect(await DB.prepare("SELECT provider,subject FROM shop_platform_bindings").first()).toEqual({ provider: "qq", subject: "114514" });
    env.PRISM_DEPLOY_PHASE = "verify";
    expect((await control({ action: "convert" })).status).toBe(200);
    const provider = JSON.parse((await DB.prepare("SELECT provider_json FROM pricing_configs").first<string>("provider_json"))!);
    expect(provider.rules[0].timeRange).toEqual({ start: "03:00", end: "19:00" });
    expect((await control({ action: "check" })).status).toBe(200);
    expect(await isDeploymentMaintenance(env)).toBe(true);
    env.PRISM_DEPLOY_PHASE = "live";
    expect((await control({ action: "resume" })).status).toBe(200);
    expect(await isDeploymentMaintenance(env)).toBe(false);
    expect(await DB.prepare("SELECT quantity FROM asset_holdings").first("quantity")).toBe(10000);
    await DB.prepare("UPDATE players SET display_name='New name'").run();
    // A delayed old worker cannot label its local-clock rules as UTC after reopening.
    await expect(DB.prepare("UPDATE pricing_configs SET provider_json=json_remove(provider_json,'$.timeZone')").run()).rejects.toThrow("UTC_PRICING_REQUIRED");
    await expect(deploymentBatch(DB, env.PRISM_DEPLOY_TOKEN_HASH!, [DB.prepare("UPDATE asset_holdings SET quantity=0")])).rejects.toThrow();
    expect(await DB.prepare("SELECT quantity FROM asset_holdings").first("quantity")).toBe(10000);
  } finally { await mf.dispose(); }
}, 30000);

test("failed SQL rolls back both the replacement table and ledger; permit is never left open", async () => {
  const { mf, DB, env, control } = await fixture();
  try {
    await control({ action: "begin" });
    const response = await control({ action: "schema", name: "9999_fail.sql", sql: "ALTER TABLE players RENAME TO old_players; SELECT * FROM deliberately_missing_table;" });
    expect(response.status).toBe(500);
    expect(await DB.prepare("SELECT name FROM d1_migrations WHERE name='9999_fail.sql'").first()).toBeNull();
    expect(await DB.prepare("SELECT display_name FROM players").first("display_name")).toBe("Player");
    expect(await DB.prepare("SELECT permit FROM prism_deployment_gate").first("permit")).toBe(0);
    expect(await isDeploymentMaintenance(env)).toBe(true);
    await expect(DB.prepare("DELETE FROM players").run()).rejects.toThrow("PRISM_MAINTENANCE");
  } finally { await mf.dispose(); }
}, 30000);

test("health failure and premature resume remain closed; repeated schema and conversion do not shift data twice", async () => {
  const { mf, env, DB, control, schema } = await fixture();
  try {
    await control({ action: "begin" }); await schema(); await schema();
    env.PRISM_DEPLOY_PHASE = "verify";
    expect((await control({ action: "convert" })).status).toBe(200);
    const once = (await DB.prepare("SELECT * FROM pricing_config_versions ORDER BY version").all()).results;
    expect((await control({ action: "convert" })).status).toBe(200);
    expect((await DB.prepare("SELECT * FROM pricing_config_versions ORDER BY version").all()).results).toEqual(once);
    expect((await control({ action: "check" }, token, async () => new Response("failed", { status: 503 }))).status).toBe(500);
    env.PRISM_DEPLOY_PHASE = "live";
    expect((await control({ action: "resume" })).status).toBe(409);
    expect(await isDeploymentMaintenance(env)).toBe(true);
    env.PRISM_DEPLOY_TOKEN_HASH = await sha256(otherToken);
    expect((await control({ action: "block" }, otherToken)).status).toBe(409);
  } finally { await mf.dispose(); }
}, 30000);

test("maintenance responses reject pages and APIs without caching or exposing deployment credentials", async () => {
  const api = maintenanceResponse(new Request("https://test/api/v1/health"));
  expect(api.status).toBe(503); expect(api.headers.get("retry-after")).toBe("30");
  expect((await api.json() as any).error.code).toBe("MAINTENANCE");
  const page = maintenanceResponse(new Request("https://test/merchant", { headers: { accept: "text/html" } }));
  expect(page.status).toBe(503); expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toContain("正在升级，请稍后重试");
});

test("a failed UTC conversion restores the marker, immutable data and write fence before retry", async () => {
  const { mf, env, DB, control, schema } = await fixture();
  try {
    await control({ action: "begin" }); await schema();
    env.PRISM_DEPLOY_PHASE = "verify";
    const before = (await DB.prepare("SELECT * FROM pricing_config_versions ORDER BY version").all()).results;
    await DB.prepare("CREATE TRIGGER fail_utc BEFORE UPDATE ON pricing_configs BEGIN SELECT RAISE(ABORT,'test conversion failure'); END").run();
    expect((await control({ action: "convert" })).status).toBe(500);
    expect(await DB.prepare("SELECT id FROM prism_data_migrations WHERE id='utc-pricing-data-v1'").first()).toBeNull();
    expect((await DB.prepare("SELECT * FROM pricing_config_versions ORDER BY version").all()).results).toEqual(before);
    expect(await DB.prepare("SELECT permit FROM prism_deployment_gate").first("permit")).toBe(0);
    await expect(DB.prepare("UPDATE asset_holdings SET quantity=0").run()).rejects.toThrow("PRISM_MAINTENANCE");
    await DB.prepare("DROP TRIGGER fail_utc").run();
    expect((await control({ action: "convert" })).status).toBe(200);
  } finally { await mf.dispose(); }
}, 30000);
