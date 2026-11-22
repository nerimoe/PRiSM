import { addLocalDays } from "@prism/core";

export type HistoryPreset = 7 | 14 | 30 | "lastMonth" | "custom";

export function historyPresetRange(today: string, preset: Exclude<HistoryPreset, "custom">) {
  if (preset === "lastMonth") {
    const to = addLocalDays(`${today.slice(0, 7)}-01`, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  return { from: addLocalDays(today, -(preset - 1)), to: today };
}
