import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import { isDeploymentMaintenance } from "../deployment-gate.js";

export async function purgeExpiredPlatformState(
  env: { DB: D1DatabaseLike },
  now = new Date(),
): Promise<void> {
  const cutoff = now.toISOString();
  const sessionCutoff = new Date(+now - 24 * 3600_000).toISOString();
  const statements = [
    ["machine_tickets", cutoff],
    ["auth_challenges", cutoff],
    ["auth_sessions", sessionCutoff],
    ["platform_binding_codes", cutoff],
    ["operation_locks", cutoff],
  ].map(([table, before]) =>
    env.DB.prepare(
      `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expires_at < ? ORDER BY expires_at LIMIT 500)`,
    ).bind(before),
  );
  await env.DB.batch([
    ...statements,
    // How pages fared is only useful while it is recent.
    env.DB.prepare(
      "DELETE FROM page_reports WHERE rowid IN (SELECT rowid FROM page_reports WHERE reported_at < ? ORDER BY reported_at LIMIT 500)",
    ).bind(new Date(+now - 30 * 24 * 3600_000).toISOString()),
  ]);
}

export async function handleScheduledCron(
  _event: { scheduledTime?: number; cron?: string },
  env: Env,
): Promise<void> {
  if (await isDeploymentMaintenance(env)) {
    return;
  }
  await purgeExpiredPlatformState(env);
}
