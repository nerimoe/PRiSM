import type { Env } from "./types";

export const deploymentGateTable = "prism_deployment_gate";
export const deploymentControlPath = "/__prism_deploy";
export const deploymentGateSchema = `CREATE TABLE IF NOT EXISTS prism_deployment_gate (
  id TEXT PRIMARY KEY CHECK(id='global'), owner_hash TEXT NOT NULL,
  maintenance INTEGER NOT NULL CHECK(maintenance IN (0,1)),
  permit INTEGER NOT NULL DEFAULT 0 CHECK(permit IN (0,1)),
  checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)), updated_at TEXT NOT NULL
)`;

const excluded = new Set([deploymentGateTable, "d1_migrations", "prism_data_migrations"]);
export function sqlIdentifier(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

export function writeFenceStatements(tables: Iterable<string>): string[] {
  return [...tables].filter(name => !excluded.has(name) && !name.startsWith("sqlite_") && !name.startsWith("_cf_")).flatMap(table => {
    const encoded = [...new TextEncoder().encode(table)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return ["INSERT", "UPDATE", "DELETE"].map(operation => `CREATE TRIGGER IF NOT EXISTS ${sqlIdentifier(`prism_maintenance_${encoded}_${operation.toLowerCase()}`)}
      BEFORE ${operation} ON ${sqlIdentifier(table)}
      WHEN EXISTS(SELECT 1 FROM prism_deployment_gate WHERE id='global' AND maintenance=1 AND permit=0)
      BEGIN SELECT RAISE(ABORT,'PRISM_MAINTENANCE'); END`);
  });
}

/** Track table replacements so their fences are restored inside the same migration transaction. */
export function tablesAfterMigration(tables: string[], statements: readonly string[]): string[] {
  const names = new Set(tables);
  for (const sql of statements) {
    const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(sql);
    const drop = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(sql);
    const rename = /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+RENAME\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(sql);
    if (create) names.add(create[1]!);
    if (drop) names.delete(drop[1]!);
    if (rename) { names.delete(rename[1]!); names.add(rename[2]!); }
    if (/^(?:CREATE|DROP)\s+TABLE\b|^ALTER\s+TABLE\b.*\bRENAME\s+TO\b/i.test(sql) && !create && !drop && !rename)
      throw new Error("Unsupported table identifier in migration; refusing an unfenced schema change");
  }
  return [...names];
}

export async function isDeploymentMaintenance(env: Env): Promise<boolean> {
  if (env.PRISM_DEPLOY_PHASE === "maintenance" || env.PRISM_DEPLOY_PHASE === "verify") return true;
  if (env.PRISM_DEPLOY_GUARD !== "1") return false;
  // Missing control state must fail closed on a production deployment.
  const row = await env.DB.prepare("SELECT maintenance FROM prism_deployment_gate WHERE id='global'").first<{ maintenance: number }>();
  return row?.maintenance !== 0;
}

export function maintenanceResponse(request: Request): Response {
  const headers = { "cache-control": "no-store", "retry-after": "30", "x-prism-maintenance": "1" };
  if (request.headers.get("accept")?.includes("text/html"))
    return new Response('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>正在升级</title><body><main><h1>正在升级，请稍后重试</h1><p>升级完成后刷新页面即可继续。</p></main></body></html>', { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  return Response.json({ error: { code: "MAINTENANCE", message: "正在升级，请稍后重试" } }, { status: 503, headers });
}

/** Only this atomic batch may write while maintenance is active; other D1 requests see permit=0. */
export async function deploymentBatch(db: D1Database, owner: string, statements: D1PreparedStatement[]) {
  return db.batch([
    db.prepare(`INSERT INTO prism_deployment_gate(id,owner_hash,maintenance,permit,checked,updated_at)
      SELECT 'global',?,1,0,0,? WHERE NOT EXISTS(
        SELECT 1 FROM prism_deployment_gate WHERE id='global' AND owner_hash=? AND maintenance=1)`)
      .bind(owner, new Date().toISOString(), owner),
    db.prepare("UPDATE prism_deployment_gate SET permit=1 WHERE id='global' AND owner_hash=?").bind(owner),
    ...statements,
    db.prepare("UPDATE prism_deployment_gate SET permit=0 WHERE id='global' AND owner_hash=?").bind(owner),
  ]);
}

/** An old in-flight worker must never publish a local clock after maintenance is released. */
export const utcWriteGuards = ["INSERT", "UPDATE"].map(operation => `CREATE TRIGGER IF NOT EXISTS prism_utc_pricing_${operation.toLowerCase()}
  BEFORE ${operation} ON pricing_configs
  WHEN NEW.kind IN ('time.priority','time.cap') AND json_extract(NEW.provider_json,'$.timeZone') IS NOT 'UTC'
  BEGIN SELECT RAISE(ABORT,'UTC_PRICING_REQUIRED'); END`);
