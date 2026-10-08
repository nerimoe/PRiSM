import { createD1Executor } from "@prism/adapter-d1";
import { migrateLegacyPricingToUtc, splitD1MigrationStatements, utcPricingMigrationId } from "@prism/storage-sql";
import { sha256 } from "./crypto";
import { migrateShopLocationTimeZones } from "./location-time-zone";
import { deploymentBatch, deploymentControlPath, deploymentGateSchema, tablesAfterMigration, utcWriteGuards, writeFenceStatements } from "./deployment-gate";
import type { Env } from "./types";

async function tableNames(db: D1Database): Promise<string[]> {
  return (await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()).results.map(row => row.name);
}

export async function deploymentControl(request: Request, env: Env,
  health: () => Promise<Response>): Promise<Response | null> {
  if (new URL(request.url).pathname !== deploymentControlPath) return null;
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,200})$/)?.[1];
  const owner = token && await sha256(token);
  if (request.method !== "POST" || !owner || owner !== env.PRISM_DEPLOY_TOKEN_HASH)
    return Response.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const result = (data: Record<string, unknown>, status = 200) => Response.json({ ...data, revision: env.PRISM_DEPLOY_REVISION, phase: env.PRISM_DEPLOY_PHASE }, { status, headers: { "cache-control": "no-store" } });
  try {
    const input = await request.json() as { action?: string; name?: string; sql?: string };
    // Readiness checks authenticate the exact upload before touching even the gate table.
    if (input.action === "probe") return result({ ok: true, phase: env.PRISM_DEPLOY_PHASE });
    if (input.action === "begin" && env.PRISM_DEPLOY_PHASE === "maintenance") {
      await env.DB.prepare(deploymentGateSchema).run();
      const tables = await tableNames(env.DB);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO prism_deployment_gate(id,owner_hash,maintenance,permit,checked,updated_at)
          VALUES('global',?,1,0,0,?) ON CONFLICT(id) DO UPDATE SET owner_hash=excluded.owner_hash,
          maintenance=1,permit=0,checked=0,updated_at=excluded.updated_at`).bind(owner, new Date().toISOString()),
        ...writeFenceStatements(tables).map(sql => env.DB.prepare(sql)),
      ]);
      return result({ ok: true, maintenance: true });
    }
    const gate = await env.DB.prepare("SELECT owner_hash,maintenance,checked FROM prism_deployment_gate WHERE id='global'")
      .first<{ owner_hash: string; maintenance: number; checked: number }>();
    if (!gate || gate.owner_hash !== owner) return result({ error: "Deployment ownership changed", code: "DEPLOYMENT_OWNERSHIP_CHANGED" }, 409);
    if (input.action === "status") return result({ ok: true, maintenance: gate.maintenance === 1, checked: gate.checked === 1 });
    if (input.action === "block") {
      await env.DB.prepare("UPDATE prism_deployment_gate SET maintenance=1,permit=0,checked=0 WHERE id='global' AND owner_hash=?").bind(owner).run();
      return result({ ok: true, maintenance: true });
    }
    if (input.action === "resume" && env.PRISM_DEPLOY_PHASE === "live" && !gate.maintenance && gate.checked)
      return result({ ok: true, maintenance: false });
    if (!gate.maintenance) return result({ error: "Maintenance must be active", code: "DEPLOYMENT_MAINTENANCE_REQUIRED" }, 409);
    const guardedDB = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: (statements: D1PreparedStatement[]) => deploymentBatch(env.DB, owner, statements),
    } as D1Database;
    if (input.action === "schema" && env.PRISM_DEPLOY_PHASE === "maintenance") {
      if (!input.name || !/^\d+_[a-z0-9_-]+\.sql$/.test(input.name) || typeof input.sql !== "string" || input.sql.length > 1_000_000)
        return result({ error: "Invalid migration" }, 400);
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
      if (await env.DB.prepare("SELECT name FROM d1_migrations WHERE name=?").bind(input.name).first())
        return result({ ok: true, skipped: true });
      const statements = splitD1MigrationStatements(input.sql);
      const tables = tablesAfterMigration(await tableNames(env.DB), statements);
      await deploymentBatch(env.DB, owner, [
        ...statements.map(sql => env.DB.prepare(sql)),
        ...writeFenceStatements(tables).map(sql => env.DB.prepare(sql)),
        env.DB.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(input.name),
      ]);
      return result({ ok: true, skipped: false });
    }
    if (input.action === "convert" && env.PRISM_DEPLOY_PHASE === "verify") {
      const pricing = await migrateLegacyPricingToUtc({ executor: createD1Executor(guardedDB), now: new Date(), id: () => crypto.randomUUID() });
      const locations = await migrateShopLocationTimeZones(guardedDB);
      await deploymentBatch(env.DB, owner, utcWriteGuards.map(sql => env.DB.prepare(sql)));
      return result({ ok: true, pricing, locations });
    }
    if (input.action === "check" && env.PRISM_DEPLOY_PHASE === "verify") {
      const markers = (await env.DB.prepare("SELECT id FROM prism_data_migrations WHERE id IN (?,?)")
        .bind(utcPricingMigrationId, "shop-location-time-zone-v1").all()).results;
      if (markers.length !== 2) throw new Error("Data migrations are incomplete");
      const invalid = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM pricing_configs WHERE kind IN ('time.priority','time.cap') AND json_extract(provider_json,'$.timeZone') IS NOT 'UTC')
        + (SELECT COUNT(*) FROM pricing_config_versions WHERE kind IN ('time.priority','time.cap') AND json_extract(provider_json,'$.timeZone') IS NOT 'UTC')
        + (SELECT COUNT(*) FROM pricing_releases WHERE time_zone!='UTC') AS n`).first<number>("n");
      if (invalid !== 0) throw new Error("UTC pricing verification failed");
      if ((await env.DB.prepare("PRAGMA foreign_key_check").all()).results.length) throw new Error("Foreign key check failed");
      const response = await health();
      if (!response.ok) throw new Error("Application health check failed");
      const body = await response.json() as { data?: { ok?: boolean } };
      if (body.data?.ok !== true) throw new Error("Invalid application health response");
      await deploymentBatch(env.DB, owner, [env.DB.prepare("UPDATE prism_deployment_gate SET checked=1 WHERE id='global' AND owner_hash=?").bind(owner)]);
      return result({ ok: true, checked: true });
    }
    if (input.action === "resume" && env.PRISM_DEPLOY_PHASE === "live") {
      if (!gate.checked) return result({ error: "Health verification is required", code: "DEPLOYMENT_VERIFICATION_REQUIRED" }, 409);
      await deploymentBatch(env.DB, owner, [env.DB.prepare("UPDATE prism_deployment_gate SET maintenance=0 WHERE id='global' AND owner_hash=? AND checked=1").bind(owner)]);
      return result({ ok: true, maintenance: false });
    }
    return result({ error: "Invalid deployment phase or action", code: "DEPLOYMENT_PHASE_NOT_READY" }, 409);
  } catch {
    // Never echo SQL, credentials, or business rows into a public response.
    return result({ error: "Deployment step failed; maintenance remains active" }, 500);
  }
}
