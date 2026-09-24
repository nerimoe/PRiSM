import { createD1Repositories } from "@prism/adapter-d1";
import { nextTimePricingEvent, type PricingConfig } from "@prism/core";
import { createPrismWorkerDependencies } from "@prism/runtime";
import type { Env } from "./types";
import { liveActivityConfig } from "./live-activity-push";

export type ActivityBill = {
  amountCents: number;
  planLabel: string;
  nextChargeAtUnix: number | null;
  nextRuleAtUnix: number | null;
  asOfUnix: number;
};

export async function activityBill(env: Pick<Env, "DB">, shopId: string, playerId: string, now = new Date()) {
  const repos = createD1Repositories({ db: env.DB, shopId, now: () => now, id: crypto.randomUUID });
  const active = await repos.sessions.findActiveByPlayerId(playerId);
  const unpaid = [...active, ...await repos.sessions.findUnpaidClosedByPlayerId(playerId)];
  if (!unpaid.length) return null;
  const preview = await createPrismWorkerDependencies(env, { shopId, now: () => now })
    .playerCheckoutCommands!.previewCheckout({ playerId });
  const releases = new Map<string, { configs: PricingConfig[]; timeZone: string }>();
  const labels = new Set<string>();
  let charge = Infinity, rule = Infinity;
  for (const session of active) {
    const key = session.pricingReleaseId ?? "legacy";
    if (!releases.has(key)) {
      const release = session.pricingReleaseId ? await repos.pricingConfigs.findRelease!(session.pricingReleaseId) : null;
      if (session.pricingReleaseId && !release) throw new Error("Pinned pricing release not found");
      releases.set(key, release ?? { configs: await repos.pricingConfigs.listEnabled(), timeZone: "UTC" });
    }
    const release = releases.get(key)!;
    for (const config of release.configs.filter(config => config.enabled && config.status !== "archived")) {
      if (config.kind !== "time.cap" && session.pricingConfigIds?.length && !session.pricingConfigIds.includes(config.id)) continue;
      if (config.kind === "charge.fixed") { labels.add(config.name); continue; }
      if (config.kind === "time.cap" && !config.provider.includedPricingConfigIds.some(id => session.pricingConfigIds?.includes(id))) continue;
      const segment = preview.chargeItems.filter(item => item.sessionId === session.id && item.pricingExplanation?.pricingConfigId === config.id).at(-1);
      const globallyCapped = preview.globalCapWindows.some(window =>
        window.windowStartedAt <= now && window.windowEndedAt > now &&
        window.paidBefore + window.currentAmount >= window.priceCap &&
        window.contributions.some(item => item.sessionId === session.id && item.pricingConfigId === config.id));
      const next = nextTimePricingEvent({
        config: { ...config.provider, timeZone: config.provider.timeZone ?? release.timeZone }, session, now,
        intervalCapReached: segment?.pricingExplanation?.intervalCapReached || globallyCapped,
        intervalStartedAt: globallyCapped ? undefined : segment?.period?.startedAt,
      });
      if (config.kind !== "time.cap" && next.ruleLabel) labels.add(`${config.name}（${next.ruleLabel}）`);
      if (next.chargeAt) charge = Math.min(charge, next.chargeAt.getTime());
      if (next.ruleAt) rule = Math.min(rule, next.ruleAt.getTime());
    }
  }
  // Confirm a candidate against the real unified bill (coupons and overlapping caps included).
  // Schedule the candidate even if a discount hides its amount change.
  const nextCheckAt = Math.min(charge, rule);
  let nextChargeAtUnix: number | null = Number.isFinite(charge) ? charge / 1000 : null;
  if (nextChargeAtUnix !== null) {
    const future = await createPrismWorkerDependencies(env, { shopId, now: () => new Date(charge) })
      .playerCheckoutCommands!.previewCheckout({ playerId });
    if (future.settlementPreview.total <= preview.settlementPreview.total) nextChargeAtUnix = null;
  }
  const names = [...labels];
  const bill: ActivityBill = {
    amountCents: preview.settlementPreview.total,
    planLabel: (names.slice(0, 2).join(" · ") + (names.length > 2 ? ` 等 ${names.length} 项` : "")).slice(0, 160),
    nextChargeAtUnix,
    nextRuleAtUnix: Number.isFinite(rule) ? rule / 1000 : null,
    asOfUnix: now.getTime() / 1000,
  };
  return { bill, nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : null,
    endedAtUnix: active.length ? null : Math.max(...unpaid.map(session => (session.endedAt ?? now).getTime())) / 1000,
    startedAtUnix: Math.min(...unpaid.map(session => session.startedAt.getTime())) / 1000 };
}

// Only registered activities create work; ordinary players never get scheduled.
export async function refreshActivityBill(env: Env, shopId: string, playerId: string) {
  if (!env.LIVE_BILLING || !liveActivityConfig(env)) return;
  const token = await env.DB.prepare(`SELECT t.id FROM live_activity_tokens t
    JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
    WHERE t.shop_id=? AND a.player_id=? AND t.session_id IS NOT NULL LIMIT 1`).bind(shopId, playerId).first();
  if (!token) return;
  await env.LIVE_BILLING.getByName(JSON.stringify([shopId, playerId])).refresh(shopId, playerId);
}
