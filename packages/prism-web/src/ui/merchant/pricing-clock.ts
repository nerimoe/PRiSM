import { convertPricingRuleClock } from "@prism/core";
import type { Pricing } from "./Pricing";

/** UI weekday checkbox display order (Monday through Sunday) in JS `getDay()` numbering. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** i18n keys indexed directly by JS `Date.getDay()` (`0 = Sun` .. `6 = Sat`). */
export const WEEKDAY_KEYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** Maps a JS `getDay()` weekday number (0–6) to its localized short key. */
export const weekdayKey = (day: number): string =>
  WEEKDAY_KEYS[((day % 7) + 7) % 7]!;

/** Toggles one JS weekday number on a rule's `weekdays` filter (empty/undefined means all days). */
export function toggleWeekday(
  current: readonly number[] | undefined,
  day: number,
  checked: boolean,
): number[] {
  const base = current ?? [0, 1, 2, 3, 4, 5, 6];
  return checked
    ? [...new Set([...base, day])]
    : base.filter((d) => d !== day);
}

export function pricingInZone(value: Pricing, from: string, to: string, referenceDate: string): Pricing {
  if (value.kind === "charge.fixed") return value;
  return { ...value, provider: { ...value.provider, timeZone: to,
    rules: value.provider.rules?.map(rule => convertPricingRuleClock(rule, from, to, referenceDate)),
  } };
}
