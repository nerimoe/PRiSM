import type { DurableObject } from "cloudflare:workers";
import { activityBill, type ActivityBill } from "./live-activity-billing.js";
import {
  LiveActivityPusher,
  liveActivityConfig,
  liveActivityEndPayload,
  liveActivityStartPayload,
  liveActivityUpdatePayload,
} from "./live-activity-push.js";
import type { Env } from "../bindings.js";
import { isDeploymentMaintenance } from "../deployment-gate.js";
import {
  checkAlarmBudget,
  spendAlarmBudget,
  nextMaintenanceRetry,
  MIN_BILLING_ALARM_INTERVAL_MS,
  type AlarmBudget,
  type MaintenanceWait,
} from "./alarm-budget.js";
import { logger } from "../log.js";

const log = logger("live-activity");

type Visit = { shopId: string; playerId: string; revision: number; terminal?: boolean; urgent?: boolean };

/**
 * iOS ends a Live Activity after eight hours: it leaves the Dynamic Island and stays on the
 * Lock Screen frozen. Before that, a visit still going on is shown by a new activity, pushed
 * to the same install, and the old one is ended and dismissed at once; the phone sees the
 * same card carry on. The time is the old activity's registration, a little after it began.
 */
export const ROTATE_AFTER_MS = 7.5 * 3600_000;
/** How long to wait before trying again to rotate an activity whose new start was not delivered. */
export const ROTATE_RETRY_MS = 10 * 60_000;

type Token = {
  id: string;
  token: string;
  /** The install showing it, which a new activity is pushed to when it is rotated. */
  client_id?: string | null;
  user_id?: string;
  environment: "sandbox" | "production";
  bundle_id: string;
  session_id: string;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  payment_status: string;
  checkout_total: number | null;
  settled_at: string | null;
};

type Retry = { signature: string; failures: number; nextAt: number };

/** Which card a line is about: whose visit, which install shows it, and its row. Never the push token itself. */
const cardFields = (visit: Pick<Visit, "shopId" | "playerId">, token: Token) => ({
  shopId: visit.shopId,
  playerId: visit.playerId,
  userId: token.user_id ?? null,
  sessionId: token.session_id,
  clientId: token.client_id ?? null,
  cardId: token.id,
  environment: token.environment,
  bundleId: token.bundle_id,
  cardAgeMinutes: Math.round((Date.now() - Date.parse(token.created_at)) / 60_000),
});
/** An install as a line names it: short enough to read, long enough to tell two phones apart. */
const install = (token: Token) => token.client_id ? `install ${token.client_id.slice(0, 8)}` : "an unknown install";
type Snapshot = Awaited<ReturnType<typeof activityBill>>;
type CachedBill = { revision: number; calculatedAt: number; snapshot: Snapshot };

let BaseDurableObject: typeof DurableObject;
try {
  // @ts-ignore
  const cf = await import("cloudflare:workers");
  BaseDurableObject = cf.DurableObject;
} catch {
  BaseDurableObject = class MockDurableObject {
    constructor(public ctx: any, public env: any) {}
  } as any;
}

export class LiveBilling extends BaseDurableObject<Env> {
  async refresh(shopId: string, playerId: string, terminal = false, urgent = false): Promise<void> {
    const previous = await this.ctx.storage.get<Visit>("visit");
    const visit: Visit = {
      shopId,
      playerId,
      revision: (previous?.revision ?? 0) + 1,
      terminal: terminal || previous?.terminal || false,
      urgent: urgent || previous?.urgent || false,
    };
    await this.ctx.storage.put("visit", visit);
    // Every DO has exactly one alarm. Do not keep pushing it forward under
    // frequent refreshes or override a deployment-maintenance backoff.
    const now = Date.now();
    if (await this.ctx.storage.get<MaintenanceWait>("maintenance-wait")) {
      // A maintenance alarm may still be scheduled long after the deployment
      // has resumed. Wake promptly only once maintenance is confirmed over.
      let maintenance = true;
      try { maintenance = await isDeploymentMaintenance(this.env); } catch { /* fail closed */ }
      if (maintenance) return;
      await this.ctx.storage.delete("maintenance-wait");
    }
    const gate = checkAlarmBudget(
      await this.ctx.storage.get<AlarmBudget>("alarm-budget"), now,
    );
    const target = (visit.terminal || visit.urgent) ? now + 1000 : Math.max(now + 1000, gate.nextAllowedAt);
    const pending = await this.ctx.storage.getAlarm();
    // Preserve any earlier alarm; every invocation checks the budget again.
    if (pending !== null && pending > now && pending <= target) return;
    await this.ctx.storage.setAlarm(target);
  }

  private async deferMaintenanceAlarm(): Promise<void> {
    const now = Date.now();
    const plan = nextMaintenanceRetry(
      await this.ctx.storage.get<MaintenanceWait>("maintenance-wait"), now,
    );
    if (plan.nextAt === null) {
      // A Live Activity token only lives for eight hours. Never leave a
      // permanent 30-second loop when a deployment or the D1 gate is stuck.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put("maintenance-wait", plan.state);
    await this.ctx.storage.setAlarm(plan.nextAt);
  }

  async alarm(): Promise<void> {
    try {
      if (await isDeploymentMaintenance(this.env)) {
        await this.deferMaintenanceAlarm();
        return;
      }
    } catch {
      await this.deferMaintenanceAlarm();
      return;
    }
    if (await this.ctx.storage.get<MaintenanceWait>("maintenance-wait")) {
      await this.ctx.storage.delete("maintenance-wait");
    }
    const visit = await this.ctx.storage.get<Visit>("visit");
    const config = liveActivityConfig(this.env);
    if (!visit || !config) return;
    const start = Date.now();
    const gate = checkAlarmBudget(
      await this.ctx.storage.get<AlarmBudget>("alarm-budget"), start,
    );
    if (!gate.allowed && !visit.terminal && !visit.urgent) {
      await this.ctx.storage.setAlarm(Math.max(start + 1000, gate.nextAllowedAt));
      return;
    }
    // Ordinary calculations consume quota even when they fail or stay unchanged.
    // Business changes and settled activities have a per-token delivery limit.
    if (gate.allowed) await this.ctx.storage.put("alarm-budget", spendAlarmBudget(gate, start));
    const { shopId, playerId } = visit;
    const tokens = (
      await this.env.DB.prepare(
        `SELECT t.id,t.token,t.environment,t.bundle_id,t.session_id,t.created_at,t.client_id,t.user_id,s.started_at,s.ended_at,s.payment_status,
        pc.total AS checkout_total,pc.settled_at
        FROM live_activity_tokens t JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
        JOIN sessions s ON s.shop_id=t.shop_id AND s.id=t.session_id AND s.player_id=a.player_id
        LEFT JOIN settlements st ON st.shop_id=s.shop_id AND st.session_id=s.id
        LEFT JOIN player_checkouts pc ON pc.shop_id=st.shop_id AND pc.id=st.checkout_id
        WHERE t.shop_id=? AND a.player_id=?`,
      )
        .bind(shopId, playerId)
        .all<Token>()
    ).results;
    const now = Date.now();
    // Server-issued tokens are at most eight hours old. Reject malformed or
    // far-future timestamps rather than scheduling alarms for months or years
    // after restoring bad legacy data.
    const valid = tokens.filter((token) => {
      const createdAt = Date.parse(token.created_at);
      return Number.isFinite(createdAt)
        && createdAt <= now + 60_000
        && createdAt + 8 * 3600_000 > now;
    });
    const expired = tokens.filter((token) => !valid.includes(token));
    if (expired.length) {
      await this.env.DB.batch(
        expired.map((token) =>
          this.env.DB.prepare(
            "DELETE FROM live_activity_tokens WHERE id=? AND token=?",
          ).bind(token.id, token.token),
        ),
      );
      await Promise.all(expired.flatMap((token) => [
        this.ctx.storage.delete(`sent:${token.id}`),
        this.ctx.storage.delete(`retry:${token.id}`),
      ]));
    }
    if (!valid.length) {
      // Preserve the small persistent budget across token churn. Otherwise
      // unregistering and registering a new activity would reset the limiter.
      const budget = await this.ctx.storage.get<AlarmBudget>("alarm-budget");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      if (budget) await this.ctx.storage.put("alarm-budget", budget);
      return;
    }
    const cached = await this.ctx.storage.get<CachedBill>("bill");
    const snapshot = valid.every(token => token.payment_status === "paid") ? null :
      cached &&
      cached.revision === visit.revision &&
      now - cached.calculatedAt < 30_000 &&
      (!cached.snapshot?.nextCheckAt || cached.snapshot.nextCheckAt > now)
        ? cached.snapshot
        : await activityBill(this.env, shopId, playerId, new Date(now));
    if (!cached || snapshot !== cached.snapshot) {
      await this.ctx.storage.put("bill", {
        revision: visit.revision,
        calculatedAt: now,
        snapshot,
      });
    }
    if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) {
      return;
    }
    const pusher = new LiveActivityPusher({ config });
    let nextRetryAt = Infinity;
    let nextTerminalAt = Infinity;
    let nextUrgentAt = Infinity;
    // Hard ceiling for APNs execution time: at most four network requests in
    // one alarm. Rotate across pre-existing oversized token sets fairly.
    const cursor = (await this.ctx.storage.get<number>("token-cursor")) ?? 0;
    const offset = cursor % valid.length;
    const ordered = [...valid.slice(offset), ...valid.slice(0, offset)];
    let attempted = 0;
    let inspected = 0;
    let hasUnprocessed = false;
    for (const token of ordered) {
      // Cap *storage reads* as well as APNs calls for legacy oversized token
      // sets (which may predate the new four-activity registration quota).
      if (attempted >= 4 || inspected >= 16) {
        hasUnprocessed = true;
        break;
      }
      inspected += 1;
      if (
        (await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision
      ) {
        return;
      }
      const ended = token.payment_status === "paid" || !snapshot;
      if (!ended && snapshot && token.client_id && now >= Date.parse(token.created_at) + ROTATE_AFTER_MS) {
        const failedAt = await this.ctx.storage.get<number>(`rotate-failed:${token.id}`);
        if (!failedAt || now - failedAt >= ROTATE_RETRY_MS) {
          attempted += 1;
          if (await this.rotate(token, snapshot, pusher, visit, now)) continue;
          await this.ctx.storage.put(`rotate-failed:${token.id}`, now);
        }
      }
      // Business changes must invalidate preloaded bills even when ordinary quota is exhausted.
      if (!ended && !gate.allowed && !visit.urgent) continue;
      const bill: ActivityBill | undefined =
        ended && token.checkout_total !== null
          ? {
              amountCents: token.checkout_total,
              planLabel: "",
              nextEvent: null,
              asOfUnix: now / 1000,
            }
          : snapshot?.bill;
      const startedAtUnix = new Date(token.started_at).getTime() / 1000;
      const payload = ended
        ? liveActivityEndPayload({
            startedAtUnix,
            endedAtUnix: token.ended_at
              ? new Date(token.ended_at).getTime() / 1000
              : now / 1000,
            now: Math.floor(now / 1000),
            bill,
          })
        : liveActivityUpdatePayload({
            startedAtUnix,
            endedAtUnix: snapshot?.endedAtUnix,
            now: Math.floor(now / 1000),
            bill,
            nextBill: snapshot?.nextBill,
            staleAfterSeconds: snapshot?.nextCheckAt
              ? Math.max(1, Math.ceil(snapshot.nextCheckAt / 1000) - Math.floor(now / 1000))
              : 3600,
          });
      // Exclude asOf/timestamp from deduplication, but include token rotation.
      const signature = JSON.stringify([
        token.token,
        ended,
        ended ? token.ended_at : snapshot?.endedAtUnix,
        bill && { ...bill, asOfUnix: 0 },
        !ended && snapshot?.nextBill,
      ]);
      if ((await this.ctx.storage.get<string>(`sent:${token.id}`)) === signature) {
        continue;
      }
      const retryKey = `retry:${token.id}`;
      const retry = await this.ctx.storage.get<Retry>(retryKey);
      if (
        retry?.signature === signature &&
        (retry.nextAt > now || retry.failures >= 6)
      ) {
        nextRetryAt = Math.min(nextRetryAt, retry.nextAt);
        if (ended && retry.failures < 6) nextTerminalAt = Math.min(nextTerminalAt, retry.nextAt);
        if (visit.urgent && retry.failures < 6) nextUrgentAt = Math.min(nextUrgentAt, retry.nextAt);
        continue;
      }
      attempted += 1;
      const result = await pusher.send(
        {
          token: token.token,
          environment: token.environment,
          bundleId: token.bundle_id,
        },
        payload,
        visit.urgent ? "10" : undefined,
      );
      log[result.kind === "failed" ? "warn" : "info"](`${ended ? "end" : "update"} push to ${install(token)} of player ${visit.playerId}: ${result.kind}`, {
        ...cardFields(visit, token),
        event: "live_activity_push", activityEvent: ended ? "end" : "update", outcome: result.kind,
        priority: ended || visit.urgent ? 10 : 5,
        ...(result.kind === "failed" ? {
          status: result.status,
          reason: result.reason && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(result.reason)
            ? result.reason : result.status ? "apns_error" : "transport_error",
        } : {}),
      });
      if (result.kind === "failed") {
        const failures = (retry?.signature === signature ? retry.failures : 0) + 1;
        const expiresAt = new Date(token.created_at).getTime() + 8 * 3600_000;
        const nextAt =
          failures >= 6
            ? expiresAt
            : now + Math.min(60_000, 5000 * 2 ** (failures - 1));
        await this.ctx.storage.put(retryKey, { signature, failures, nextAt });
        nextRetryAt = Math.min(nextRetryAt, nextAt);
        if (ended && failures < 6) nextTerminalAt = Math.min(nextTerminalAt, nextAt);
        if (visit.urgent && failures < 6) nextUrgentAt = Math.min(nextUrgentAt, nextAt);
        continue;
      }
      await this.ctx.storage.delete(retryKey);
      if (result.kind === "expired" || (ended && result.kind === "delivered")) {
        await this.env.DB.prepare(
          "DELETE FROM live_activity_tokens WHERE id=? AND token=?",
        )
          .bind(token.id, token.token)
          .run();
        await this.ctx.storage.delete(`sent:${token.id}`);
      } else if (result.kind === "delivered") {
        await this.ctx.storage.put(`sent:${token.id}`, signature);
      }
    }
    if (inspected > 0 && valid.length > 1) {
      await this.ctx.storage.put("token-cursor", (offset + inspected) % valid.length);
    }
    if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) {
      return;
    }
    if (hasUnprocessed && visit.terminal) nextTerminalAt = Math.min(nextTerminalAt, Date.now() + MIN_BILLING_ALARM_INTERVAL_MS);
    if (hasUnprocessed && visit.urgent) nextUrgentAt = Math.min(nextUrgentAt, Date.now() + MIN_BILLING_ALARM_INTERVAL_MS);
    await this.ctx.storage.put("visit", {
      ...visit, terminal: Number.isFinite(nextTerminalAt), urgent: Number.isFinite(nextUrgentAt),
    });
    const expiresAt = Math.min(
      ...valid.map((token) => new Date(token.created_at).getTime() + 8 * 3600_000),
    );
    // The next activity due to be rotated, or a rotation to try again.
    let rotateAt = Infinity;
    if (snapshot) for (const token of valid) {
      if (!token.client_id || token.payment_status === "paid") continue;
      const failedAt = await this.ctx.storage.get<number>(`rotate-failed:${token.id}`);
      rotateAt = Math.min(rotateAt, failedAt ? failedAt + ROTATE_RETRY_MS : Date.parse(token.created_at) + ROTATE_AFTER_MS);
    }
    const next = Math.min(
      snapshot?.nextCheckAt ?? Infinity,
      expiresAt,
      rotateAt,
      nextRetryAt,
      hasUnprocessed ? Date.now() + MIN_BILLING_ALARM_INTERVAL_MS : Infinity,
    );
    if (snapshot || Number.isFinite(nextRetryAt) || hasUnprocessed) {
      const later = Date.now();
      const budget = checkAlarmBudget(
        await this.ctx.storage.get<AlarmBudget>("alarm-budget"), later,
      );
      await this.ctx.storage.setAlarm(
        Math.max(later + 1000, Math.min(nextTerminalAt, nextUrgentAt,
          Math.max(Number.isFinite(next) ? next : later + MIN_BILLING_ALARM_INTERVAL_MS, budget.nextAllowedAt))),
      );
    } else {
      // Preserve the small persistent budget across token churn. Otherwise
      // unregistering and registering a new activity would reset the limiter.
      const budget = await this.ctx.storage.get<AlarmBudget>("alarm-budget");
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      if (budget) await this.ctx.storage.put("alarm-budget", budget);
    }
  }

  /**
   * Shows the visit on a new activity before iOS ends this one: a start pushed to the same
   * install, with the bill as it stands, then the old activity ended and dismissed at once.
   * False when no start was delivered (the install has no start token, or APNs refused it);
   * the old activity then carries on as before until it can be rotated.
   */
  private async rotate(token: Token, snapshot: NonNullable<Snapshot>, pusher: LiveActivityPusher, visit: Visit, now: number): Promise<boolean> {
    const { shopId } = visit;
    const card = cardFields(visit, token);
    if (!token.user_id || !token.client_id) return false;
    const starts = (await this.env.DB.prepare(
      "SELECT id, token, environment, bundle_id FROM live_activity_start_tokens WHERE user_id=? AND client_id=?",
    ).bind(token.user_id, token.client_id).all<{ id: string; token: string; environment: "sandbox" | "production"; bundle_id: string }>()).results;
    const shop = await this.env.DB.prepare("SELECT public_id AS publicId, name FROM shops WHERE id=?")
      .bind(shopId).first<{ publicId: string; name: string }>();
    if (!starts.length || !shop) {
      log.warn(`cannot rotate the card on ${install(token)} of player ${visit.playerId}: ${shop ? "that install has no start token" : "the shop is gone"}`, {
        ...card, event: "live_activity_rotated", outcome: shop ? "no_start_token" : "no_shop",
      });
      return false;
    }
    const nowSeconds = Math.floor(now / 1000);
    const startedAtUnix = Date.parse(token.started_at) / 1000;
    const payload = liveActivityStartPayload({
      sessionId: token.session_id, shopCode: shop.publicId, shopName: shop.name,
      origin: this.env.APP_ORIGIN || "https://link.neri.moe",
      startedAtUnix, now: nowSeconds, bill: snapshot.bill, nextBill: snapshot.nextBill,
      staleAfterSeconds: snapshot.nextCheckAt ? Math.max(1, Math.ceil(snapshot.nextCheckAt / 1000) - nowSeconds) : undefined,
    });
    let delivered = false;
    const outcomes: string[] = [];
    for (const start of starts) {
      const result = await pusher.send({ token: start.token, environment: start.environment, bundleId: start.bundle_id }, payload, "10");
      outcomes.push(result.kind);
      if (result.kind === "delivered") delivered = true;
      if (result.kind === "expired") {
        await this.env.DB.prepare("DELETE FROM live_activity_start_tokens WHERE id=? AND token=?").bind(start.id, start.token).run();
      }
    }
    if (!delivered) {
      log.warn(`could not start a new card on ${install(token)} of player ${visit.playerId}; keeping the old one and trying again later`, {
        ...card, event: "live_activity_rotated", outcome: "not_started", startPushes: outcomes,
      });
      return false;
    }
    // The new activity carries the visit on; the old one goes at once rather than freezing.
    const dismissed = await pusher.send(
      { token: token.token, environment: token.environment, bundleId: token.bundle_id },
      liveActivityEndPayload({ startedAtUnix, endedAtUnix: now / 1000, now: nowSeconds, bill: snapshot.bill, dismissalAfterSeconds: 0 }),
      "10",
    );
    await this.env.DB.prepare("DELETE FROM live_activity_tokens WHERE id=? AND token=?").bind(token.id, token.token).run();
    log.info(`rotated the card on ${install(token)} of player ${visit.playerId} after ${(card.cardAgeMinutes / 60).toFixed(1)} h; old card dismiss: ${dismissed.kind}`, {
      ...card, event: "live_activity_rotated", outcome: "started", startPushes: outcomes, dismiss: dismissed.kind,
    });
    await Promise.all([`sent:${token.id}`, `retry:${token.id}`, `rotate-failed:${token.id}`].map((key) => this.ctx.storage.delete(key)));
    return true;
  }
}
