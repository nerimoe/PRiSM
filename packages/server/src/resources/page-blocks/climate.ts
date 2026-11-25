import type { ClimateState, PageClimate, PageClimateMode } from "@prism/page-protocol";
import type { Locale } from "../../notices.js";
import type { Translate } from "../page-text.js";

const CLIMATE_MODES: Record<string, { label: string; icon?: PageClimateMode["icon"] }> = {
  off: { label: "已关闭" },
  cool: { label: "制冷", icon: "cool" },
  heat: { label: "制热", icon: "heat" },
  dry: { label: "除湿", icon: "dry" },
  fan_only: { label: "送风", icon: "fan" },
  auto: { label: "自动", icon: "auto" },
  heat_cool: { label: "自动冷暖", icon: "auto" },
};

const CLIMATE_FANS: Record<string, string> = {
  auto: "自动",
  silent: "静音",
  quiet: "静音",
  low: "低风",
  medium: "中风",
  middle: "中风",
  high: "高风",
  strong: "强劲",
  turbo: "强劲",
};

export function climateBlock(
  state: ClimateState | null,
  needsLocation: boolean,
  locale: Locale,
  t: Translate,
): PageClimate {
  const room = state?.currentTemperature !== null && state?.currentTemperature !== undefined
    ? Number(state.currentTemperature.toFixed(1))
    : null;
  const modeEntry = state ? CLIMATE_MODES[state.mode] : undefined;
  return {
    kind: "climate",
    id: "climate",
    state,
    needsLocation,
    title: t("空调"),
    unknownStatus: t("空调状态未知"),
    offLabel: t("已关闭"),
    roomText: room !== null ? (locale === "en" ? `Room ${room}°` : `室温 ${room}°`) : null,
    currentModeLabel: state ? (modeEntry ? t(modeEntry.label) : state.mode) : null,
    turnOnLabel: t("开空调"),
    turnOffLabel: t("关空调"),
    temperatureLabel: t("设定温度"),
    lowerTemperatureLabel: t("调低温度"),
    raiseTemperatureLabel: t("调高温度"),
    modeLabel: t("模式"),
    fanLabel: t("风速"),
    modes: (state?.modes ?? []).filter((mode) => mode !== "off").map((value) => {
      const known = CLIMATE_MODES[value];
      return { value, label: known ? t(known.label) : value, ...(known?.icon ? { icon: known.icon } : {}) };
    }),
    fanModes: (state?.fanModes ?? []).map((value) => {
      const known = CLIMATE_FANS[value.toLowerCase()];
      return { value, label: known ? t(known) : value };
    }),
    actions: {
      on: "climate.on",
      off: "climate.off",
      setMode: "climate.set_mode",
      setTemperature: "climate.set_temperature",
      setFanMode: "climate.set_fan_mode",
    },
  };
}
