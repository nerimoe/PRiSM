import type { LivePlayer } from "./shared";

export function liveBilling(player: LivePlayer) {
  const active = player.sessions.filter(session => session.status === "active");
  const plans = new Map(active.flatMap(session => session.pricingCharges.map(charge => [charge.pricingConfigId, charge.planName] as const)));
  const status = player.estimatedTotal === null ? "预估暂不可用"
    : player.walletTotal < player.estimatedTotal ? "余额不足"
    : active.length ? "计费中" : "待结账";
  return { status, planKey: JSON.stringify([...plans.keys()].sort()), plans: [...plans.values()].sort() };
}

export function stayDuration(minutes: number) {
  const value = Math.max(0, Math.floor(minutes));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
