import { convertPricingRuleClock } from "@prism/core";
import type { Pricing } from "./Pricing";

export function pricingInZone(value: Pricing, from: string, to: string, referenceDate: string): Pricing {
  if (value.kind === "charge.fixed") return value;
  return { ...value, provider: { ...value.provider, timeZone: to,
    rules: value.provider.rules?.map(rule => convertPricingRuleClock(rule, from, to, referenceDate)),
  } };
}
