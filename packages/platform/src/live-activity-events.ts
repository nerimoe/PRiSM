import type { Context } from "hono";
import {
  LiveActivityPusher,
  liveActivityConfig,
  liveActivityEndPayload,
  liveActivityUpdatePayload,
  type LiveActivityPushRecord,
} from "./live-activity-push";
import type { AppBindings } from "./types";

type C = Context<AppBindings>;

/**
 * Bridges store session events to the phones that are showing them.
 *
 * A session is started or settled in one of three channels — the player's own app, the
 * admin console, or a shop bot — but all three funnel through `forward()`. Hooking here
 * means the core billing domain stays unaware that Live Activities exist, and a new
 * channel cannot silently miss notifications.
 */

/** Exact paths that open a visit, relative to the `/player/` or `/integration/` mount. */
const SESSION_START_PATHS = new Set([
  "session/start",
  "players/by-identity/session/start",
]);

/** Paths that close a visit, including the per-session stop and the bulk active checkout. */
function isSessionEndPath(path: string): boolean {
  return (
    path === "checkout/confirm" ||
    path === "checkout/override" ||
    path === "sessions/active/checkout" ||
    path === "players/by-identity/checkout/confirm" ||
    path === "players/by-identity/checkout/override" ||
    /^players\/[^/]+\/checkout\/(confirm|override)$/.test(path) ||
    /^players\/[^/]+\/sessions\/[^/]+\/stop$/.test(path) ||
    /^players\/by-identity\/sessions\/[^/]+\/stop$/.test(path)
  );
}

export function sessionEventForPath(path: string): "start" | "end" | null {
  // The admin console addresses a player explicitly, so its start path carries an id.
  if (SESSION_START_PATHS.has(path) || /^players\/[^/]+\/session\/start$/.test(path)) {
    return "start";
  }
  return isSessionEndPath(path) ? "end" : null;
}

type SessionRow = {
  id: string;
  startedAt: string;
};

/**
 * Resolves the store session a response refers to, so the push can carry its start time.
 * The shapes differ per channel: a start returns `session`, a checkout returns a
 * settlement plus per-session details.
 */
export function extractSessionIds(
  payload: Record<string, unknown>,
  event: "start" | "end",
): string[] {
  const ids: string[] = [];
  const session = payload.session as { id?: unknown } | undefined;
  if (session && typeof session.id === "string") ids.push(session.id);
  for (const key of ["sessions", "sessionDetails"] as const) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = item as { sessionId?: unknown; session?: { sessionId?: unknown } };
      const id = record?.session?.sessionId ?? record?.sessionId;
      if (typeof id === "string") ids.push(id);
    }
  }
  // A checkout answers with settlement records that nest the session id.
  const settlements = payload.settlements;
  if (Array.isArray(settlements)) {
    for (const item of settlements) {
      const record = item as { settlement?: { sessionId?: unknown }; sessionId?: unknown };
      const id = record?.settlement?.sessionId ?? record?.sessionId;
      if (typeof id === "string") ids.push(id);
    }
  }
  if (event === "end" && ids.length === 0) {
    // A stop endpoint answers with the session itself.
    const stopped = payload.session as { id?: unknown } | undefined;
    if (stopped && typeof stopped.id === "string") ids.push(stopped.id);
  }
  return Array.from(new Set(ids));
}

/**
 * Looks up the sessions a response touched, keyed by id, to recover their start times.
 * Missing rows simply yield no push rather than a wrong timer.
 */
async function loadSessions(c: C, shopId: string, ids: string[]): Promise<Map<string, SessionRow>> {
  const found = new Map<string, SessionRow>();
  if (ids.length === 0) return found;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT id, started_at AS startedAt FROM sessions WHERE shop_id=? AND id IN (${placeholders})`,
  )
    .bind(shopId, ...ids)
    .all<SessionRow>();
  for (const row of rows.results ?? []) found.set(row.id, row);
  return found;
}

type TokenRow = {
  id: string;
  token: string;
  environment: "sandbox" | "production";
  bundle_id: string;
  session_id: string | null;
  created_at: string;
};

/**
 * Sends the update/end for a session that a channel just opened or settled.
 *
 * Runs inside `waitUntil`, so a slow or failing APNs call never delays the billing
 * response the player or staff member is waiting on.
 */
export async function pushSessionEvent(
  c: C,
  input: { shopId: string; playerId: string; sessionIds: string[]; event: "start" | "end" },
): Promise<void> {
  const config = liveActivityConfig(c.env);
  // No APNs credentials (local, beta, tests) means the whole feature is inert.
  if (!config) return;

  const tokens = await c.env.DB.prepare(
    `SELECT t.id, t.token, t.environment, t.bundle_id, t.session_id, t.created_at
     FROM live_activity_tokens t
     JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
     WHERE t.shop_id=? AND a.player_id=?`,
  )
    .bind(input.shopId, input.playerId)
    .all<TokenRow>();
  const rows = tokens.results ?? [];
  if (rows.length === 0) return;

  const sessions = await loadSessions(c, input.shopId, input.sessionIds);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const pusher = new LiveActivityPusher({ config });

  for (const row of rows) {
    // Match each activity to the session it is actually showing. An activity created
    // before any session existed has no session id and is only updated by `start`.
    const sessionId =
      input.sessionIds.find((id) => id === row.session_id) ?? input.sessionIds[0] ?? null;
    const startedAt = sessionId ? sessions.get(sessionId)?.startedAt : undefined;
    const startedAtUnix = startedAt
      ? Math.floor(new Date(startedAt).getTime() / 1000)
      : Math.floor(new Date(row.created_at).getTime() / 1000);
    if (!Number.isFinite(startedAtUnix)) continue;

    const payload =
      input.event === "start"
        ? liveActivityUpdatePayload({ startedAtUnix, now: nowSeconds })
        : liveActivityEndPayload({ startedAtUnix, endedAtUnix: nowSeconds });

    const outcome = await pusher.send(
      {
        token: row.token,
        environment: row.environment,
        bundleId: row.bundle_id,
      } satisfies LiveActivityPushRecord,
      payload,
    );

    if (outcome.kind === "expired") {
      // The activity is gone (dismissed, or the app was deleted). Drop the row so later
      // sessions do not keep pushing to a dead token.
      await c.env.DB.prepare("DELETE FROM live_activity_tokens WHERE id=?").bind(row.id).run();
      continue;
    }
    if (outcome.kind === "failed") {
      console.error("Live Activity push failed", {
        shopId: input.shopId,
        status: outcome.status,
        reason: outcome.reason,
      });
      continue;
    }
    if (outcome.kind === "delivered") {
      // Track which session the activity now shows, so a later `end` reuses its timer.
      await c.env.DB.prepare("UPDATE live_activity_tokens SET session_id=?, updated_at=? WHERE id=?")
        .bind(input.event === "start" ? sessionId : null, new Date().toISOString(), row.id)
        .run();
    }
  }
}

/**
 * Wraps a `forward()` call so that a successful session start or settlement fans out to
 * the player's phones.
 *
 * The response body is read through `clone()` because the caller still has to return the
 * original response; consuming it here would hand the client an empty body.
 */
export async function forwardWithLiveActivity(
  c: C,
  input: { shopId: string; event: "start" | "end" },
  execute: () => Promise<Response>,
): Promise<Response> {
  const response = await execute();
  if (!response.ok || !liveActivityConfig(c.env)) return response;

  let task: Promise<void> | null = null;
  try {
    // The response body is cloned: the caller still returns the original, so consuming it
    // here would hand the client an empty body.
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const sessionIds = extractSessionIds(payload, input.event);
    const playerId = playerIdFromPayload(payload);
    if (playerId && sessionIds.length > 0) {
      task = pushSessionEvent(c, {
        shopId: input.shopId,
        playerId,
        sessionIds,
        event: input.event,
      });
    }
  } catch (error) {
    // Planning failed, so nothing will be sent. Worth knowing about, but it must not fail
    // a billing request that already succeeded.
    console.error("Live Activity dispatch planning failed", error);
    return response;
  }
  if (!task) return response;

  // Delivery must never delay the billing response. `waitUntil` is the right tool, but a
  // caller without an execution context (tests, or any non-Worker host) would throw, so
  // fall back to letting the promise settle on its own.
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task.catch((error) => console.error("Live Activity push failed", error));
  }
  return response;
}

/**
 * Reads the player from whatever shape the channel returned. Start answers carry
 * `session.playerId`; checkouts carry `playerSettlement.playerId` or per-session details.
 * Resolving from the response is what lets the bot channel — which identifies players by
 * QQ or card, never by account id — participate without special casing.
 */
export function playerIdFromPayload(payload: Record<string, unknown>): string | null {
  const direct = payload.playerId;
  if (typeof direct === "string" && direct) return direct;
  const session = payload.session as { playerId?: unknown } | undefined;
  if (typeof session?.playerId === "string" && session.playerId) return session.playerId;
  const settlement = payload.playerSettlement as { playerId?: unknown } | undefined;
  if (typeof settlement?.playerId === "string" && settlement.playerId) return settlement.playerId;
  for (const key of ["sessions", "sessionDetails"] as const) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const record = item as { playerId?: unknown };
      if (typeof record?.playerId === "string" && record.playerId) return record.playerId;
    }
  }
  return null;
}
