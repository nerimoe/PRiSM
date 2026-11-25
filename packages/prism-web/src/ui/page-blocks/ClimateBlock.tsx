import { Droplets, Fan, Loader2, Minus, Plus, Power, RefreshCcw, Snowflake, Sun, type LucideIcon } from "lucide-react";
import type { PageClimate, PageClimateMode } from "@prism/page-protocol";
import { useClimate } from "../ClimateControls";
import { InlineNoticeLine } from "./notices";
import { usePageContext } from "./page-context";

const pageClimateIcons: Record<NonNullable<PageClimateMode["icon"]>, LucideIcon> = {
  cool: Snowflake,
  heat: Sun,
  dry: Droplets,
  fan: Fan,
  auto: RefreshCcw,
};

/** Up to six options share one row; a longer list wraps instead of crushing labels. */
const segments = (count: number) =>
  count <= 6 ? { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` } : undefined;

export function ClimateBlock({ block }: { block: PageClimate }) {
  const { actions } = usePageContext();
  const note = actions.noteFor(block.id);
  return (
    <div className="grid gap-3">
      <PlayerClimate
        block={block}
        busy={actions.busy?.id === block.id ? actions.busy.action : ""}
        blocked={actions.blocked}
        send={(action, extra) => void actions.run(block.id, action, extra, block.needsLocation)}
      />
      {note && <InlineNoticeLine note={note} />}
    </div>
  );
}

/**
 * The player's air conditioner on the device page. Off, it is one clear
 * button; on, the target temperature is the centre of the card with mode and
 * fan speed as segmented rows underneath. The card takes the running mode's
 * colour, so cooling and heating read at a glance.
 */
function PlayerClimate({
  block,
  busy,
  blocked,
  send,
}: {
  block: PageClimate;
  /** The climate action in flight, if any. */
  busy: string;
  /** Another action or a card swipe is running. */
  blocked: boolean;
  send: (action: string, extra?: Record<string, unknown>) => void;
}) {
  const { state } = block;
  const climate = useClimate(state, blocked, send, block.actions);
  const { view } = climate;
  const spinner = <Loader2 size={20} className="animate-spin" aria-hidden="true" />;
  const activeMode = view?.mode ?? state?.mode ?? "off";
  const activeModeLabel =
    block.modes.find((item) => item.value === activeMode)?.label ??
    (activeMode === state?.mode ? block.currentModeLabel : null) ??
    activeMode;
  const status = !state
    ? block.unknownStatus
    : [climate.on ? activeModeLabel : block.offLabel, block.roomText]
        .filter(Boolean)
        .join(" · ");
  const powerButton = (on: boolean, primary: boolean) => {
    const action = on ? block.actions.on : block.actions.off;
    return (
      <button
        type="button"
        className={`session-action${primary ? " primary" : ""}`}
        disabled={blocked}
        onClick={() => send(action)}
      >
        {busy === action ? spinner : <Power size={20} aria-hidden="true" />}
        {on ? block.turnOnLabel : block.turnOffLabel}
      </button>
    );
  };
  return (
    <section
      className="player-climate"
      data-mode={climate.on ? view?.mode : "off"}
      aria-label={block.title}
    >
      <header className="player-climate-head">
        <div>
          <h2>{block.title}</h2>
          <p>{status}</p>
        </div>
        {climate.on && (
          <button
            type="button"
            className="player-climate-off"
            disabled={blocked}
            onClick={() => send(block.actions.off)}
          >
            {busy === block.actions.off ? spinner : <Power size={16} aria-hidden="true" />}
            {block.turnOffLabel}
          </button>
        )}
      </header>
      {!state ? (
        <div className="player-climate-power">
          {powerButton(true, true)}
          {powerButton(false, false)}
        </div>
      ) : !climate.on ? (
        powerButton(true, true)
      ) : (
        <>
          {view?.temperature !== null && view?.temperature !== undefined && (
            <div className="player-climate-temp" role="group" aria-label={block.temperatureLabel}>
              <button
                type="button"
                aria-label={block.lowerTemperatureLabel}
                disabled={view.temperature <= climate.min}
                onClick={() => climate.nudge(-1)}
              >
                <Minus size={24} />
              </button>
              <div>
                <output aria-live="polite">
                  {view.temperature}
                  <span>°</span>
                </output>
                <small>{block.temperatureLabel}</small>
              </div>
              <button
                type="button"
                aria-label={block.raiseTemperatureLabel}
                disabled={view.temperature >= climate.max}
                onClick={() => climate.nudge(1)}
              >
                <Plus size={24} />
              </button>
            </div>
          )}
          {block.modes.length > 0 && (
            <div className="player-climate-group">
              <span className="player-climate-label">{block.modeLabel}</span>
              <div className="player-climate-segments" role="group" aria-label={block.modeLabel} style={segments(block.modes.length)}>
                {block.modes.map((item) => {
                  const Icon = item.icon ? pageClimateIcons[item.icon] : undefined;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={view?.mode === item.value}
                      disabled={blocked}
                      onClick={() => climate.chooseMode(item.value)}
                    >
                      {busy === block.actions.setMode && view?.mode === item.value
                        ? spinner
                        : Icon && <Icon size={20} aria-hidden="true" />}
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {block.fanModes.length > 0 && (
            <div className="player-climate-group">
              <span className="player-climate-label">{block.fanLabel}</span>
              <div className="player-climate-segments is-text" role="group" aria-label={block.fanLabel} style={segments(block.fanModes.length)}>
                {block.fanModes.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={view?.fanMode === item.value}
                    disabled={blocked}
                    onClick={() => climate.chooseFan(item.value)}
                  >
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
