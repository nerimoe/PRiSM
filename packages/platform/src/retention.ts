import type { Env } from "./types";

export async function purgeExpiredPlatformState(env: Env, now = new Date()) {
  const cutoff = now.toISOString();
  const sessionCutoff = new Date(+now - 24 * 3600_000).toISOString();
  const statements = [
    ["machine_tickets", cutoff], ["auth_challenges", cutoff],
    ["auth_sessions", sessionCutoff], ["platform_binding_codes", cutoff], ["operation_locks", cutoff],
  ].map(([table, before]) => env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN
    (SELECT rowid FROM ${table} WHERE expires_at < ? ORDER BY expires_at LIMIT 500)`).bind(before));
  await env.DB.batch(statements);
}
