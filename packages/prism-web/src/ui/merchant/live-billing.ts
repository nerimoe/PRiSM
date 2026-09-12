import type { LivePlayer } from "./shared";

// Group the complete unsettled bill, including concurrent sessions, without duplicating players.
export function liveBilling(player: Pick<LivePlayer, "sessions">) {
  const plans = new Map<string, string>();
  const periods = new Map<string, string>();
  for (const session of player.sessions) {
    for (const charge of session.pricingCharges ?? []) {
      plans.set(charge.pricingConfigId, charge.planName);
    }
    for (const segment of session.pricingSegments ?? []) {
      plans.set(segment.pricingConfigId, segment.planName);
      const range = segment.ruleTimeRange;
      const time = range ? ` ${range.start}–${range.end}` : "";
      periods.set(JSON.stringify([segment.pricingConfigId, segment.ruleId, range]),
        `${segment.planName} · ${segment.ruleLabel}${time}`);
    }
    for (const charge of session.pricingCharges ?? []) {
      if (!session.pricingSegments?.some(segment => segment.pricingConfigId === charge.pricingConfigId)) {
        periods.set(JSON.stringify([charge.pricingConfigId, charge.ruleLabel]), `${charge.planName} · ${charge.ruleLabel}`);
      }
    }
  }
  return {
    planKey: JSON.stringify([...plans.keys()].sort()),
    periodKey: JSON.stringify([...periods.keys()].sort()),
    plans: [...plans].sort(([a], [b]) => a.localeCompare(b)).map(([, label]) => label),
    periods: [...periods].sort(([a], [b]) => a.localeCompare(b)).map(([, label]) => label),
  };
}
