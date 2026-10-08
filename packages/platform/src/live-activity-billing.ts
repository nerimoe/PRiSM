import { createD1Repositories } from "@prism/adapter-d1";
import {
  addCents,
  canStartPriorityTimePricingSession,
  compareCents,
  maxCents,
  nextTimePricingEvent,
  previousBillingEvent,
  subCents,
  ZERO_CENTS,
  type Cents,
  type PricingConfig,
} from "@prism/core";
import { createPrismWorkerDependencies, ensureD1UtcPricing } from "@prism/runtime";
import type { Env } from "./types";
import { liveActivityConfig } from "./live-activity-push";

export type ActivityNextEvent = {
  atUnix: number;
  label: string;
};

export type ActivityBill = {
  amountCents: number;
  planLabel: string;
  nextEvent: ActivityNextEvent | null;
  /** Last resolved pricing/rule/session event. Refresh timestamps are not events. */
  previousEvent?: ActivityNextEvent | null;
  asOfUnix: number;
  /** Amount still chargeable before the effective cap: the minimum over every
   *  cap window covering `now` that this session contributes to. 0 means capped.
   *  Omitted when no cap is in force, so the client can tell "capped" from "no
   *  cap configured" instead of having to guess. */
  remainingToCapCents?: Cents;
  /** False while no stacked plan of the visit is billable ("非营业") at this
   *  moment. Omitted once every session is closed, because billing is over and
   *  the question no longer applies. */
  billable?: boolean;
};

export async function activityBill(env: Pick<Env, "DB">, shopId: string, playerId: string, now = new Date()) {
  await ensureD1UtcPricing(env.DB, now);
  const repos = createD1Repositories({ db: env.DB, shopId, now: () => now, id: crypto.randomUUID });
  const active = await repos.sessions.findActiveByPlayerId(playerId);
  const unpaid = [...active, ...await repos.sessions.findUnpaidClosedByPlayerId(playerId)];
  if (!unpaid.length) return null;
  const preview = await createPrismWorkerDependencies(env, { shopId, now: () => now })
    .playerCheckoutCommands!.previewCheckout({ playerId });
  const releases = new Map<string, { configs: PricingConfig[]; timeZone: string }>();
  const labels = new Set<string>();
  const candidates: { at: number; label: string }[] = [];
  const ruleBoundaries: Date[] = [];
  const capHeadrooms: Cents[] = [];
  const billableNow: boolean[] = [];
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
      // Headroom to the tightest cap window that covers `now` and that this
      // session contributes to -- the same windows `globallyCapped` reads, so
      // the bar and the countdown can never disagree.
      if (config.kind === "time.cap") {
        for (const window of preview.globalCapWindows ?? []) {
          const inForce = window.windowStartedAt <= now && window.windowEndedAt > now;
          // The window's contributions are keyed by the *pricing* config that
          // charged the session, not by the cap config itself, so matching on
          // `config.id` here would never fire (that is also why the existing
          // `globallyCapped` predicate above reads narrower than it looks).
          const involves = window.contributions.some(item =>
            item.sessionId === session.id &&
            (session.pricingConfigIds ?? []).includes(item.pricingConfigId));
          if (inForce && involves) {
            capHeadrooms.push(subCents(window.priceCap, addCents(window.paidBefore, window.currentAmount)));
          }
        }
      }
      // Business hours: a plan with no active rule at `now` is not billable, so
      // the island may say billing stopped rather than keep counting.
      if (config.kind === "time.priority") {
        const priority = config as Extract<PricingConfig, { kind: "time.priority" }>;
        billableNow.push(canStartPriorityTimePricingSession({
          config: { ...priority.provider, timeZone: priority.provider.timeZone ?? release.timeZone },
          at: now,
        }));
      }
      const next = nextTimePricingEvent({
        config: { ...config.provider, timeZone: config.provider.timeZone ?? release.timeZone }, session, now,
        intervalCapReached: segment?.pricingExplanation?.intervalCapReached || globallyCapped,
        intervalStartedAt: globallyCapped ? undefined : segment?.period?.startedAt,
      });
      ruleBoundaries.push(next.intervalStartedAt);
      if (config.kind !== "time.cap" && next.ruleLabel) labels.add(`${config.name}（${next.ruleLabel}）`);
      // Every event candidate is a peer — charges and rule switches alike —
      // because each one triggers a full recompute and push.
      if (next.chargeAt) candidates.push({ at: next.chargeAt.getTime(), label: "下次计费" });
      if (next.ruleAt) candidates.push({ at: next.ruleAt.getTime(), label: "规则切换" });
    }
  }
  // Confirm a candidate against the real unified bill (coupons and overlapping caps included).
  // Every candidate is a peer: the earliest one is both the next alarm and the
  // displayed next event, and coincident candidates with different labels merge
  // into the combined text.
  const nextCheckAt = candidates.reduce((min, candidate) => Math.min(min, candidate.at), Infinity);
  let nextEvent: ActivityNextEvent | null = null;
  if (candidates.length) {
    const earliest = candidates.reduce((a, b) => (b.at < a.at ? b : a));
    const earliestLabels = new Set(candidates.filter(candidate => candidate.at === earliest.at).map(candidate => candidate.label));
    nextEvent = {
      atUnix: earliest.at / 1000,
      label: earliestLabels.size > 1 ? "计费与规则切换" : earliest.label,
    };
  }
  // Both aggregates are additive and optional so older clients keep decoding:
  // remainingToCapCents is omitted when no cap is in force (which must not be
  // confused with capped), and billable is omitted once billing is over.
  let remainingToCapCents: Cents | undefined;
  if (capHeadrooms.length) {
    const tightest = capHeadrooms.reduce((min, value) => (compareCents(value, min) < 0 ? value : min));
    remainingToCapCents = maxCents(tightest, ZERO_CENTS);
  }
  const billable = active.length === 0
    ? undefined
    : billableNow.length === 0 ? true : billableNow.some(value => value);

  const names = [...labels];
  const previous = previousBillingEvent({ now, sessions: unpaid, chargeItems: preview.chargeItems,
    globalCapWindows: preview.globalCapWindows, ruleBoundaries });
  const bill: ActivityBill = {
    amountCents: preview.settlementPreview.total,
    planLabel: (names.slice(0, 2).join(" · ") + (names.length > 2 ? ` 等 ${names.length} 项` : "")).slice(0, 160),
    nextEvent,
    previousEvent: previous ? { atUnix: previous.at.getTime() / 1000, label: previous.label } : null,
    asOfUnix: now.getTime() / 1000,
    ...(remainingToCapCents !== undefined ? { remainingToCapCents } : {}),
    ...(billable !== undefined ? { billable } : {}),
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
