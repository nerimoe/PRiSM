import { DurableObject } from "cloudflare:workers";
import { activityBill, type ActivityBill } from "./live-activity-billing";
import { LiveActivityPusher, liveActivityConfig, liveActivityEndPayload, liveActivityUpdatePayload } from "./live-activity-push";
import type { Env } from "./types";
import { isDeploymentMaintenance } from "./deployment-gate";

type Visit = { shopId: string; playerId: string; revision: number };
type Token = { id: string; token: string; environment: "sandbox" | "production"; bundle_id: string; session_id: string; created_at: string; started_at: string; ended_at: string | null; payment_status: string; checkout_total: number | null; settled_at: string | null };

type Retry = { signature: string; failures: number; nextAt: number };
type Snapshot = Awaited<ReturnType<typeof activityBill>>;
type CachedBill = { revision: number; calculatedAt: number; snapshot: Snapshot };

export class LiveBilling extends DurableObject<Env> {
  async refresh(shopId: string, playerId: string) {
    const previous = await this.ctx.storage.get<Visit>("visit");
    await this.ctx.storage.put("visit", { shopId, playerId, revision: (previous?.revision ?? 0) + 1 });
    // Coalesce queries and same-second mutations. No timer keeps the Worker alive.
    const pending = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(Math.min(pending ?? Infinity, Date.now() + 1000));
  }

  async alarm() {
    try {
      if (await isDeploymentMaintenance(this.env)) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
      return;
    }
    const visit = await this.ctx.storage.get<Visit>("visit");
    const config = liveActivityConfig(this.env);
    if (!visit || !config) return;
    const { shopId, playerId } = visit;
    const tokens = (await this.env.DB.prepare(`SELECT t.id,t.token,t.environment,t.bundle_id,t.session_id,t.created_at,s.started_at,s.ended_at,s.payment_status,
      pc.total AS checkout_total,pc.settled_at
      FROM live_activity_tokens t JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
      JOIN sessions s ON s.shop_id=t.shop_id AND s.id=t.session_id AND s.player_id=a.player_id
      LEFT JOIN settlements st ON st.shop_id=s.shop_id AND st.session_id=s.id
      LEFT JOIN player_checkouts pc ON pc.shop_id=st.shop_id AND pc.id=st.checkout_id
      WHERE t.shop_id=? AND a.player_id=?`).bind(shopId, playerId).all<Token>()).results;
    const now = Date.now();
    const valid = tokens.filter(token => new Date(token.created_at).getTime() + 8 * 3600_000 > now);
    const expired = tokens.filter(token => !valid.includes(token));
    if (expired.length) await this.env.DB.batch(expired.map(token =>
      this.env.DB.prepare("DELETE FROM live_activity_tokens WHERE id=? AND token=?").bind(token.id, token.token)));
    if (!valid.length) { await Promise.all([this.ctx.storage.deleteAlarm(), this.ctx.storage.deleteAll()]); return; }
    const cached = await this.ctx.storage.get<CachedBill>("bill");
    const snapshot = cached && cached.revision === visit.revision && now - cached.calculatedAt < 30_000
      && (!cached.snapshot?.nextCheckAt || cached.snapshot.nextCheckAt > now)
      ? cached.snapshot : await activityBill(this.env, shopId, playerId, new Date(now));
    if (!cached || snapshot !== cached.snapshot)
      await this.ctx.storage.put("bill", { revision: visit.revision, calculatedAt: now, snapshot });
    if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) return;
    const pusher = new LiveActivityPusher({ config });
    let nextRetryAt = Infinity;
    for (const token of valid) {
      if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) return;
      const ended = token.payment_status === "paid" || !snapshot;
      const bill: ActivityBill | undefined = ended && token.checkout_total !== null ? {
        amountCents: token.checkout_total, planLabel: "", nextEvent: null, asOfUnix: now / 1000,
      } : snapshot?.bill;
      const startedAtUnix = new Date(token.started_at).getTime() / 1000;
      const payload = ended
        ? liveActivityEndPayload({ startedAtUnix, endedAtUnix: token.ended_at ? new Date(token.ended_at).getTime() / 1000 : now / 1000, now: Math.floor(now / 1000), bill })
        : liveActivityUpdatePayload({ startedAtUnix, endedAtUnix: snapshot?.endedAtUnix, now: Math.floor(now / 1000), bill,
          staleAfterSeconds: snapshot?.nextCheckAt ? Math.max(1, Math.ceil((snapshot.nextCheckAt - now) / 1000)) : 3600 });
      // Exclude asOf/timestamp from deduplication, but include token rotation.
      const signature = JSON.stringify([token.token, ended, snapshot?.endedAtUnix, bill && { ...bill, asOfUnix: 0 }]);
      if (await this.ctx.storage.get<string>(`sent:${token.id}`) === signature) continue;
      const retryKey = `retry:${token.id}`;
      const retry = await this.ctx.storage.get<Retry>(retryKey);
      if (retry?.signature === signature && (retry.nextAt > now || retry.failures >= 6)) {
        nextRetryAt = Math.min(nextRetryAt, retry.nextAt);
        continue;
      }
      const result = await pusher.send({ token: token.token, environment: token.environment, bundleId: token.bundle_id }, payload);
      if (result.kind === "failed") {
        const failures = (retry?.signature === signature ? retry.failures : 0) + 1;
        const expiresAt = new Date(token.created_at).getTime() + 8 * 3600_000;
        const nextAt = failures >= 6 ? expiresAt : now + Math.min(60_000, 5000 * 2 ** (failures - 1));
        await this.ctx.storage.put(retryKey, { signature, failures, nextAt });
        nextRetryAt = Math.min(nextRetryAt, nextAt);
        continue;
      }
      await this.ctx.storage.delete(retryKey);
      if (result.kind === "expired" || (ended && result.kind === "delivered")) {
        await this.env.DB.prepare("DELETE FROM live_activity_tokens WHERE id=? AND token=?").bind(token.id, token.token).run();
      }
      if (result.kind === "delivered") await this.ctx.storage.put(`sent:${token.id}`, signature);
    }
    if ((await this.ctx.storage.get<Visit>("visit"))?.revision !== visit.revision) return;
    const expiresAt = Math.min(...valid.map(token => new Date(token.created_at).getTime() + 8 * 3600_000));
    const next = Math.min(snapshot?.nextCheckAt ?? Infinity, expiresAt, nextRetryAt);
    if (snapshot || Number.isFinite(nextRetryAt)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await Promise.all([this.ctx.storage.deleteAlarm(), this.ctx.storage.deleteAll()]);
  }
}
