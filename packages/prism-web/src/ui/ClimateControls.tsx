import { useEffect, useRef, useState } from "react";
import {
  Droplets,
  Fan,
  Loader2,
  Minus,
  Plus,
  Power,
  RefreshCcw,
  Snowflake,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "../i18n";
import type { ClimateState, PageClimate } from "@prism/page-protocol";

export type { ClimateState };

const modeNames: Record<string, string> = {
  off: "已关闭",
  cool: "制冷",
  heat: "制热",
  dry: "除湿",
  fan_only: "送风",
  auto: "自动",
  heat_cool: "自动冷暖",
};

const modeIcons: Record<string, LucideIcon> = {
  cool: Snowflake,
  heat: Sun,
  dry: Droplets,
  fan_only: Fan,
  auto: RefreshCcw,
  heat_cool: RefreshCcw,
};

/** Integrations name fan speeds freely; the common ones get a Chinese label. */
const fanNames: Record<string, string> = {
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

export const climateModeName = (mode: string) => modeNames[mode] ?? mode;
/** The icon for a running mode; null for off or a mode without one. */
export const climateModeIcon = (mode: string): LucideIcon | null => modeIcons[mode] ?? null;
const fanName = (mode: string) => fanNames[mode.toLowerCase()] ?? mode;

type Translate = (message: string, values?: Record<string, string | number>) => string;

/** One line for a header or a card: mode, target and room temperature. */
export function climateSummary(state: ClimateState | null, t: Translate): string {
  if (!state) return t("空调状态未知");
  return [
    t(climateModeName(state.mode)),
    state.mode !== "off" && state.temperature !== null
      ? t("设定 {value}°", { value: state.temperature })
      : "",
    state.currentTemperature !== null
      ? t("室温 {value}°", { value: state.currentTemperature })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the platform calls these actions where a page does not name them itself. */
const CLIMATE_ACTIONS: PageClimate["actions"] = {
  on: "climate.on",
  off: "climate.off",
  setMode: "climate.set_mode",
  setTemperature: "climate.set_temperature",
  setFanMode: "climate.set_fan_mode",
};

type Draft = { mode?: string; fanMode?: string; temperature?: number };

/** How long a choice is shown before the entity has to confirm it. */
const DRAFT_MS = 6000;
/**
 * Taps on − / + are gathered and sent as one temperature once they have stopped
 * for this long; each tap starts the wait again, so stepping through several
 * degrees sends one request instead of one per tap.
 */
export const TEMPERATURE_SETTLE_MS = 1000;

/**
 * What the controls show and send. A choice appears at once instead of after
 * the round trip through Home Assistant, which can lag behind a service call;
 * it is dropped when the entity reports it, or after a few seconds if it never
 * does (a refused value falls back to what the entity really has). Rapid
 * temperature taps become one request, so a location check or an HA call is
 * not repeated for every step.
 */
export function useClimate(
  state: ClimateState | null,
  blocked: boolean,
  send: (action: string, extra?: Record<string, unknown>) => void,
  actions: PageClimate["actions"] = CLIMATE_ACTIONS,
) {
  const [draft, setDraft] = useState<Draft>({});
  const [changedAt, setChangedAt] = useState(0);
  const sentTemperature = useRef<number | null>(null);
  const change = (patch: Draft) => {
    setDraft((current) => ({ ...current, ...patch }));
    setChangedAt(Date.now());
  };

  // Drop each part of the draft once the entity reports it.
  useEffect(() => {
    setDraft((current) => {
      const next = { ...current };
      if (next.mode !== undefined && next.mode === state?.mode) delete next.mode;
      if (next.fanMode !== undefined && next.fanMode === state?.fanMode) delete next.fanMode;
      if (next.temperature !== undefined && next.temperature === state?.temperature) {
        delete next.temperature;
        sentTemperature.current = null;
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [state?.mode, state?.fanMode, state?.temperature]);

  useEffect(() => {
    if (!changedAt) return;
    const timer = window.setTimeout(() => {
      setDraft({});
      sentTemperature.current = null;
    }, DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [changedAt]);

  const wanted = draft.temperature;
  useEffect(() => {
    if (wanted === undefined || blocked || wanted === sentTemperature.current) return;
    const timer = window.setTimeout(() => {
      sentTemperature.current = wanted;
      setChangedAt(Date.now());
      send(actions.setTemperature, { temperature: wanted });
    }, TEMPERATURE_SETTLE_MS);
    return () => window.clearTimeout(timer);
    // `send` is recreated on every render of the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, blocked, actions.setTemperature]);

  const view: ClimateState | null = state && {
    ...state,
    ...(draft.mode !== undefined ? { mode: draft.mode } : {}),
    ...(draft.fanMode !== undefined ? { fanMode: draft.fanMode } : {}),
    ...(draft.temperature !== undefined ? { temperature: draft.temperature } : {}),
  };
  const step = state?.temperatureStep ?? 0.5;
  const min = state?.minTemperature ?? 16;
  const max = state?.maxTemperature ?? 30;
  const decimals = String(step).split(".")[1]?.length ?? 0;
  return {
    view,
    min,
    max,
    modes: (state?.modes ?? []).filter((mode) => mode !== "off"),
    on: !!state && state.mode !== "off",
    chooseMode(mode: string) {
      if (mode === view?.mode) return;
      change({ mode });
      send(actions.setMode, { mode });
    },
    chooseFan(fanMode: string) {
      if (fanMode === view?.fanMode) return;
      change({ fanMode });
      send(actions.setFanMode, { fanMode });
    },
    nudge(direction: 1 | -1) {
      const current = view?.temperature;
      if (current === null || current === undefined) return;
      const next = Number(Math.min(max, Math.max(min, current + direction * step)).toFixed(decimals));
      if (next !== current) change({ temperature: next });
    },
  };
}

/** Compact controls for the staff action panel. */
export function ClimateControls({
  state,
  busy,
  disabled,
  send,
  powerClass,
}: {
  state: ClimateState | null;
  /** The action in flight, if any. */
  busy: string;
  disabled: boolean;
  send: (action: string, extra?: Record<string, unknown>) => void;
  /** Class of the on/off button, so it matches the surface it sits on. */
  powerClass: string;
}) {
  const { t } = useI18n();
  const climate = useClimate(state, disabled || !!busy, send);
  const { view } = climate;
  const locked = disabled || !!busy;
  return (
    <div className="climate-controls">
      <button
        type="button"
        className={powerClass}
        disabled={locked}
        onClick={() => send(climate.on ? "climate.off" : "climate.on")}
      >
        {t(climate.on ? "关空调" : "开空调")}
      </button>
      {climate.modes.length > 0 && (
        <div className="climate-options" role="group" aria-label={t("模式")}>
          <span className="climate-label" aria-hidden="true">{t("模式")}</span>
          {climate.modes.map((mode) => (
            <button
              key={mode}
              type="button"
              className="climate-chip"
              aria-pressed={view?.mode === mode}
              disabled={locked}
              onClick={() => climate.chooseMode(mode)}
            >
              {t(climateModeName(mode))}
            </button>
          ))}
        </div>
      )}
      {climate.on && view?.temperature !== null && view?.temperature !== undefined && (
        <div className="climate-temperature" role="group" aria-label={t("设定温度")}>
          <span className="climate-label" aria-hidden="true">{t("温度")}</span>
          <button
            type="button"
            className="climate-chip"
            aria-label={t("调低温度")}
            disabled={disabled || view.temperature <= climate.min}
            onClick={() => climate.nudge(-1)}
          >
            <Minus size={18} />
          </button>
          <output aria-live="polite">{view.temperature}°</output>
          <button
            type="button"
            className="climate-chip"
            aria-label={t("调高温度")}
            disabled={disabled || view.temperature >= climate.max}
            onClick={() => climate.nudge(1)}
          >
            <Plus size={18} />
          </button>
        </div>
      )}
      {climate.on && !!view?.fanModes.length && (
        <div className="climate-options" role="group" aria-label={t("风速")}>
          <span className="climate-label" aria-hidden="true">{t("风速")}</span>
          {view.fanModes.map((mode) => (
            <button
              key={mode}
              type="button"
              className="climate-chip"
              aria-pressed={view.fanMode === mode}
              disabled={locked}
              onClick={() => climate.chooseFan(mode)}
            >
              {t(fanName(mode))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
