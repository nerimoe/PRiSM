import type { Context } from "hono";
import type { AppBindings } from "../../bindings.js";
import { sha256Hex } from "../../crypto.js";
import { logger } from "../../log.js";
import { optionalUser } from "../../middleware/auth.js";
import type { ScannedResource } from "./resource-ticket.js";
import { ACCOUNT_PROFILES_SQL } from "../../resources/account-profiles.js";

const log = logger("resource-visit");
const MAX_CACHED_VISITS = 2048;
const recordedVisits = new WeakMap<object, Set<string>>();

/**
 * Record one `resource.visited` event per valid scan ticket when a signed-in user
 * accesses a valid resource link. Runs inside `executionCtx.waitUntil` when
 * available so first paint is never delayed, and never throws to the caller.
 */
export async function recordResourceVisit(
  c: Context<AppBindings>,
  machine: ScannedResource,
  ticket: string,
): Promise<void> {
  const user = optionalUser(c);
  const normalizedTicket = ticket.trim();
  if (!user || !normalizedTicket) return;

  const id = `visit:${(
    await sha256Hex(`${machine.shop_id}:${machine.id}:${user.id}:${normalizedTicket}`)
  ).slice(0, 32)}`;
  const db = c.env.DB;
  if (recordedVisits.get(db)?.has(id)) return;

  const task = (async () => {
    try {
      const occurredAt = new Date().toISOString();
      await db.prepare(
        `INSERT OR IGNORE INTO device_events (
           shop_id, id, device_id, capability, kind, name, operation_id, parent_operation_id,
           origin, player_id, staff_id, payload_json, occurred_at, via, via_resource_id
         )
         SELECT
           ?, ?, ?, 'shop', 'signal', 'resource.visited', NULL, NULL,
           'platform', a.player_id, NULL,
           CASE WHEN a.player_id IS NOT NULL THEN '{}' ELSE json_object('userId', ?) END,
           ?, 'page', NULL
         FROM (SELECT 1) AS _
         LEFT JOIN ${ACCOUNT_PROFILES_SQL} a ON a.shop_id = ? AND a.user_id = ?`,
      )
        .bind(
          machine.shop_id,
          id,
          machine.id,
          user.id,
          occurredAt,
          machine.shop_id,
          user.id,
        )
        .run();
      let cached = recordedVisits.get(db);
      if (!cached) {
        cached = new Set();
        recordedVisits.set(db, cached);
      }
      if (cached.size >= MAX_CACHED_VISITS) cached.clear();
      cached.add(id);
    } catch (error) {
      log.warn("recording resource visit failed", {
        event: "resource_visit_record_failed",
        shopId: machine.shop_id,
        deviceId: machine.id,
        error,
      });
    }
  })();

  let ctx: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = null;
  }
  if (ctx) ctx.waitUntil(task);
  else await task;
}
