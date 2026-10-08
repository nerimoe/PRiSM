import {
  buildPriorityTimePricingTimeline,
  buildTimeCapPricingTimeline,
  quantizePricingProvider,
} from "@prism/core";
import type {
  PriorityTimePricingProviderConfig,
  TimeCapPricingProviderConfig,
} from "@prism/core";
import type { Pricing } from "./Pricing";

/** Stored rule clocks remain UTC; only the calendar/ring is projected into the UI zone. */
export function pricingPreview(
  value: Pricing,
  localDate: string,
  displayTimeZone: string,
  roundMoney = false,
) {
  if (value.kind === "charge.fixed") return null;
  const rules = (value.provider.rules ?? []).map((rule) => ({
    ...rule,
    ...(rule.dateTimeRange
      ? {
          dateTimeRange: {
            start: new Date(rule.dateTimeRange.start),
            end: new Date(rule.dateTimeRange.end),
          },
        }
      : {}),
  }));
  if (value.kind === "time.cap")
    return buildTimeCapPricingTimeline({
      localDate,
      displayTimeZone,
      config: roundMoney
        ? quantizePricingProvider({
            ...value.provider,
            rules,
          } as TimeCapPricingProviderConfig)
        : ({ ...value.provider, rules } as TimeCapPricingProviderConfig),
    });
  return buildPriorityTimePricingTimeline({
    localDate,
    displayTimeZone,
    config: roundMoney
      ? quantizePricingProvider({
          ...value.provider,
          rules,
        } as PriorityTimePricingProviderConfig)
      : ({ ...value.provider, rules } as PriorityTimePricingProviderConfig),
  });
}
