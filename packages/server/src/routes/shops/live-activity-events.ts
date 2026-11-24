import type { Context } from "hono";
import {
  LiveActivityPusher,
  liveActivityConfig,
  liveActivityEndPayload,
  liveActivityStartPayload,
  maskToken,
  type LiveActivityPushRecord,
  type ApnsTransport,
} from "../../durable-objects/live-activity-push.js";
import type { AppBindings } from "../../bindings.js";
import { activityBill, refreshActivityBill } from "../../durable-objects/live-activity-billing.js";
import { logger } from "../../log.js";
import { ACCOUNT_PROFILES_SQL, profileAccountId } from "../../resources/account-profiles.js";

const log = logger("live-activity");

type C = Context<AppBindings>;

/** How long the phone that entered has to show the visit itself before it is pushed a start. */
export const OWN_START_GRACE_MS = 15_000;

/**
 * An install registers its start token every time it runs; one silent this long is gone (the
 * app removed, an App Clip the full app replaced) and is no longer pushed starts.
 */
export const START_TOKEN_MAX_AGE_MS = 30 * 24 * 3600_000;

/**
 * Tells the phones that are showing a visit that it started or ended.
 *
 * Whoever starts or settles a session (a player, staff, the cashier, a bot)
 * does it through the shop's services, which publish it as a fact; the
 * billing subscriber (`events/subscribers.ts`) calls this. The core billing
 * domain stays unaware that Live Activities exist.
 */

type SessionRow = {
  id: string;
  startedAt: string;
  endedAt: string | null;
};

/**
 * Looks up the sessions a response touched, keyed by id, to recover their start/end times.
 * Missing rows simply yield no push rather than a wrong timer.
 */
async function loadSessions(c: Pick<C, "env">, shopId: string, ids: string[]): Promise<Map<string, SessionRow>> {
  const found = new Map<string, SessionRow>();
  if (ids.length === 0) return found;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT id, started_at AS startedAt, ended_at AS endedAt FROM sessions WHERE shop_id=? AND id IN (${placeholders})`,
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
  client_id: string | null;
};

/** An install as a line names it: short enough to read, long enough to tell two phones apart. */
const installName = (clientId: string | null | undefined) => clientId ? `install ${clientId.slice(0, 8)}` : "an unknown install";

type StartTokenRow = {
  id: string;
  token: string;
  environment: "sandbox" | "production";
  bundle_id: string;
  client_id: string;
};

/**
 * Sends the start/end for a session that a channel just opened or settled.
 *
 * Runs inside `waitUntil`, so a slow or failing APNs call never delays the billing
 * response the player or staff member is waiting on.
 */
export async function pushSessionEvent(
  c: Pick<C, "env">,
  input: {
    shopId: string;
    playerId: string;
    sessionIds: string[];
    event: "start" | "end";
    initiatorClientId?: string | null;
  },
  // Test seam: APNs transport is injectable, never replaced in production.
  transport?: ApnsTransport,
  options: {
    /** Runs work after the caller is answered; without it the entering phone is never pushed its own start. */
    later?: (work: Promise<unknown>) => void;
    /** Test seam for the entering phone's grace period. */
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const config = liveActivityConfig(c.env);
  // No APNs credentials (local, beta, tests) means the whole feature is inert.
  if (!config) return;

  if (c.env.LIVE_BILLING) {
    // A genuine completed session may send its final end state promptly.
    // Final delivery is bounded per activity by deduplication and retry limits.
    await refreshActivityBill(c.env, input.shopId, input.playerId, input.event === "end", true);
    // The scheduler checks all remaining sessions before ending the visit.
    if (input.event === "end") return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const pusher = new LiveActivityPusher({ config, transport });

  if (input.event === "start") {
    if (c.env.LIVE_BILLING) {
      const first = await c.env.DB.prepare("SELECT id FROM sessions WHERE shop_id=? AND player_id=? AND payment_status='unpaid' ORDER BY started_at,id LIMIT 1")
        .bind(input.shopId, input.playerId).first<{ id: string }>();
      if (first && !input.sessionIds.includes(first.id)) return;
    }
    // Push-to-start: users who have previously signed in on a supported iOS device
    // registered their push-to-start tokens. We fan out APNs event=start so their
    // Dynamic Island / Live Activity starts automatically even if the app is killed.
    const userId = await profileAccountId(c.env.DB, input.shopId, input.playerId);
    if (!userId) return;
    const account = { userId };

    const freshSince = new Date(Date.now() - START_TOKEN_MAX_AGE_MS).toISOString();
    await c.env.DB.prepare("DELETE FROM live_activity_start_tokens WHERE user_id=? AND updated_at<?")
      .bind(account.userId, freshSince).run();
    const startTokens = await c.env.DB.prepare(
      `SELECT id, token, environment, bundle_id, client_id
       FROM live_activity_start_tokens
       WHERE user_id=?`,
    )
      .bind(account.userId)
      .all<StartTokenRow>();
    const tokenRows = startTokens.results ?? [];
    if (tokenRows.length === 0) return;

    const shopRow = await c.env.DB.prepare(
      "SELECT public_id AS publicId, name FROM shops WHERE id=?",
    )
      .bind(input.shopId)
      .first<{ publicId: string; name: string }>();
    if (!shopRow) return;

    const sessions = await loadSessions(c, input.shopId, input.sessionIds);
    const sessionId = input.sessionIds[0];
    if (!sessionId) return;
    const sessionRow = sessions.get(sessionId);
    if (!sessionRow) return;
    const startedAtUnix = Math.floor(new Date(sessionRow.startedAt).getTime() / 1000);
    if (!Number.isFinite(startedAtUnix)) return;

    const origin = c.env.APP_ORIGIN || "https://link.neri.moe";
    const snapshot = c.env.LIVE_BILLING ? await activityBill(c.env, input.shopId, input.playerId) : null;
    const payload = liveActivityStartPayload({
      sessionId,
      shopCode: shopRow.publicId,
      shopName: shopRow.name,
      origin,
      startedAtUnix,
      now: nowSeconds,
      bill: snapshot?.bill,
      nextBill: snapshot?.nextBill,
      staleAfterSeconds: snapshot?.nextCheckAt ? Math.max(1, Math.ceil(snapshot.nextCheckAt / 1000 - nowSeconds)) : undefined,
    });

    const sendStart = async (row: StartTokenRow) => {
      const outcome = await pusher.send(
        {
          token: row.token,
          environment: row.environment,
          bundleId: row.bundle_id,
        } satisfies LiveActivityPushRecord,
        payload,
      );
      if (outcome.kind === "expired") {
        await c.env.DB.prepare("DELETE FROM live_activity_start_tokens WHERE id=?").bind(row.id).run();
      } else if (outcome.kind === "delivered") {
        await c.env.DB.prepare("UPDATE live_activity_start_tokens SET last_seen_at=? WHERE id=?")
          .bind(new Date().toISOString(), row.id)
          .run();
      }
      log[outcome.kind === "failed" ? "error" : "info"](`start push to ${installName(row.client_id)} of player ${input.playerId}: ${outcome.kind}`, {
        event: "live_activity_push", activityEvent: "start", outcome: outcome.kind,
        shopId: input.shopId, playerId: input.playerId, userId: account.userId, sessionId,
        clientId: row.client_id, environment: row.environment, bundleId: row.bundle_id, token: maskToken(row.token),
        ...(outcome.kind === "failed" ? { status: outcome.status, reason: outcome.reason } : {}),
      });
    };
    // The phone that entered starts its own activity in the foreground, so it is not pushed
    // one at once: that would show the visit twice. iOS sometimes refuses that start for
    // minutes, though, and nothing else would show the visit there; so when the phone has
    // not registered an activity for the visit after a grace period, it is pushed one too.
    const own = tokenRows.filter((row) => input.initiatorClientId && row.client_id === input.initiatorClientId);
    for (const row of tokenRows) if (!own.includes(row)) await sendStart(row);
    if (own.length && options.later) {
      const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      options.later((async () => {
        await wait(OWN_START_GRACE_MS);
        const shown = await c.env.DB.prepare(
          `SELECT 1 FROM live_activity_tokens WHERE shop_id=? AND user_id=? AND session_id=? AND client_id=? LIMIT 1`,
        ).bind(input.shopId, account.userId, sessionId, input.initiatorClientId ?? null).first();
        const open = await c.env.DB.prepare(
          "SELECT 1 FROM sessions WHERE shop_id=? AND id=? AND ended_at IS NULL AND payment_status='unpaid'",
        ).bind(input.shopId, sessionId).first();
        if (shown || !open) return;
        log.info(`the entering phone (${installName(input.initiatorClientId)}) showed no card after ${OWN_START_GRACE_MS / 1000} s; pushing it one`, {
          event: "live_activity_own_start_missing", shopId: input.shopId, playerId: input.playerId, sessionId, clientId: input.initiatorClientId ?? null,
        });
        for (const row of own) await sendStart(row);
      })().catch((error) => log.error(`could not check whether the entering phone showed a card for player ${input.playerId}`, { shopId: input.shopId, playerId: input.playerId, sessionId, error })));
    }
    return;
  }

  // End event: find existing per-activity tokens.
  // Match by player account, or directly by session_id when known, so tokens tied to the
  // ending session are always resolved even if identity resolution differed across channels.
  let tokensQuery: string;
  let bindings: string[];
  if (input.sessionIds.length > 0) {
    const placeholders = input.sessionIds.map(() => "?").join(",");
    tokensQuery = `SELECT DISTINCT t.id, t.token, t.environment, t.bundle_id, t.session_id, t.created_at, t.client_id
     FROM live_activity_tokens t
     LEFT JOIN ${ACCOUNT_PROFILES_SQL} a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
     WHERE t.shop_id=? AND (t.session_id IN (${placeholders}) OR a.player_id=?)`;
    bindings = [input.shopId, ...input.sessionIds, input.playerId];
  } else {
    tokensQuery = `SELECT t.id, t.token, t.environment, t.bundle_id, t.session_id, t.created_at, t.client_id
     FROM live_activity_tokens t
     JOIN ${ACCOUNT_PROFILES_SQL} a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
     WHERE t.shop_id=? AND a.player_id=?`;
    bindings = [input.shopId, input.playerId];
  }
  const tokens = await c.env.DB.prepare(tokensQuery)
    .bind(...bindings)
    .all<TokenRow>();
  const rows = tokens.results ?? [];
  if (rows.length === 0) return;

  const sessions = await loadSessions(c, input.shopId, input.sessionIds);

  for (const row of rows) {
    const sessionId =
      input.sessionIds.find((id) => id === row.session_id) ?? input.sessionIds[0] ?? null;
    const sessionRow = sessionId ? sessions.get(sessionId) : undefined;
    const startedAt = sessionRow?.startedAt;
    const startedAtUnix = startedAt
      ? Math.floor(new Date(startedAt).getTime() / 1000)
      : Math.floor(new Date(row.created_at).getTime() / 1000);
    if (!Number.isFinite(startedAtUnix)) continue;

    // Authoritative ended_at from the database session row
    const endedAtUnix = sessionRow?.endedAt
      ? Math.floor(new Date(sessionRow.endedAt).getTime() / 1000)
      : nowSeconds;

    const payload = liveActivityEndPayload({ startedAtUnix, endedAtUnix });
    const outcome = await pusher.send(
      {
        token: row.token,
        environment: row.environment,
        bundleId: row.bundle_id,
      } satisfies LiveActivityPushRecord,
      payload,
    );

    log[outcome.kind === "failed" ? "error" : "info"](`end push to ${installName(row.client_id)} of player ${input.playerId}: ${outcome.kind}`, {
      event: "live_activity_push", activityEvent: "end", outcome: outcome.kind,
      shopId: input.shopId, playerId: input.playerId, sessionId, cardId: row.id,
      clientId: row.client_id, environment: row.environment, bundleId: row.bundle_id, token: maskToken(row.token),
      ...(outcome.kind === "failed" ? { status: outcome.status, reason: outcome.reason } : {}),
    });
    if (outcome.kind === "expired") {
      await c.env.DB.prepare("DELETE FROM live_activity_tokens WHERE id=?").bind(row.id).run();
      continue;
    }
    if (outcome.kind === "failed") continue;
    if (outcome.kind === "delivered") {
      await c.env.DB.prepare("UPDATE live_activity_tokens SET session_id=NULL, updated_at=? WHERE id=?")
        .bind(new Date().toISOString(), row.id)
        .run();
    }
  }
}

