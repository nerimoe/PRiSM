import type { ClimateState } from "../ClimateControls";

/**
 * What the board knows of one device's power and air conditioner. A value that
 * is absent has not been said yet (the backend is still asking); `null` is one
 * the backend could not read. `watching` is the "实时" label and nothing else:
 * the board never decides anything by it, the backend has decided already.
 */
export type BoardState = { watching: boolean; power?: "on" | "off" | null; climate?: ClimateState | null };
export type BoardStates = Record<string, BoardState>;

/**
 * One device after something was said about it: the label as said, and each
 * value that was said. A value not said keeps what the board showed, however
 * old: a value that is out of date is still a value.
 */
export function applyBoardState(previous: BoardState | null | undefined, next: Partial<BoardState>): BoardState {
  return {
    watching: next.watching ?? previous?.watching ?? false,
    ...(previous?.power !== undefined ? { power: previous.power } : {}),
    ...(previous?.climate !== undefined ? { climate: previous.climate } : {}),
    ...(next.power !== undefined ? { power: next.power } : {}),
    ...(next.climate !== undefined ? { climate: next.climate } : {}),
  };
}

/**
 * The board after an HTTP answer (the refresh button, the fallback, an action's
 * answer). A device the hub has said something about since the question was
 * asked keeps what the hub said: the answer is older than that.
 */
export function applyBoardAnswer(
  states: BoardStates | null,
  answer: BoardStates,
  askedAt: number,
  pushedAt: Readonly<Record<string, number>>,
): BoardStates {
  const next: BoardStates = { ...(states ?? {}) };
  for (const [id, state] of Object.entries(answer)) {
    if ((pushedAt[id] ?? 0) > askedAt) continue;
    next[id] = applyBoardState(next[id], state);
  }
  return next;
}

/** Whether a device still waits for a value it has: the backend has not said it yet. */
export function awaitingState(state: BoardState | null, caps: { power: boolean; climate: boolean }): boolean {
  return !state || (caps.power && state.power === undefined) || (caps.climate && state.climate === undefined);
}

/** Who is watching Home Assistant for the shop: one entry per bot or HINATA IO the platform has handed the watch. */
export type WatcherPhase = "watching" | "subscribing" | "starting" | "confirming" | "unreachable";
export type BoardWatcher =
  | { id: string; kind: "bot"; name: string; state: WatcherPhase }
  | { id: string; kind: "device"; deviceId: string; state: WatcherPhase };
/**
 * `limit` is the shop's number of slots, which the platform administrator sets up to `max`; `standby` is how many
 * more are online and waiting for one.
 */
export type BoardWatchers = { limit: number; max: number; watchers: BoardWatcher[]; standby: number };

/** A frame the shop hub pushes to the board. */
export type BoardFrame =
  /** Devices' labels and values: the whole shop when the board connects or liveness changes, then what Home Assistant said. */
  | { type: "states"; states: Record<string, Partial<BoardState>> }
  /** What one device shows now; a key that is absent was not part of it. */
  | { type: "state"; deviceId: string; power?: "on" | "off" | null; climate?: ClimateState | null }
  /** Who is watching, when the board connects and whenever that changes. */
  | ({ type: "watchers" } & BoardWatchers);

const powerOf = (value: unknown): "on" | "off" | null => (value === "on" || value === "off" ? value : null);
const phaseOf = (value: unknown): WatcherPhase =>
  value === "watching" || value === "subscribing" || value === "confirming" || value === "unreachable" ? value : "starting";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** The label and the values a record says; what it does not say is left out. */
export function viewOf(value: Record<string, unknown>): Partial<BoardState> {
  return {
    ...(typeof value.watching === "boolean" ? { watching: value.watching } : {}),
    ...("power" in value ? { power: powerOf(value.power) } : {}),
    ...("climate" in value ? { climate: isRecord(value.climate) ? (value.climate as ClimateState) : null } : {}),
  };
}

/** A frame from the hub, or null for anything that is not one. */
export function parseBoardFrame(raw: string): BoardFrame | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(frame)) return null;
  if (frame.type === "watchers" && Array.isArray(frame.watchers) && typeof frame.limit === "number") {
    const watchers: BoardWatcher[] = [];
    for (const item of frame.watchers) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      if (item.kind === "bot") watchers.push({ id: item.id, kind: "bot", name: typeof item.name === "string" ? item.name : "Bot", state: phaseOf(item.state) });
      else if (item.kind === "device" && typeof item.deviceId === "string")
        watchers.push({ id: item.id, kind: "device", deviceId: item.deviceId, state: phaseOf(item.state) });
    }
    return {
      type: "watchers",
      limit: frame.limit,
      max: typeof frame.max === "number" ? frame.max : Math.max(frame.limit, 1),
      watchers,
      standby: typeof frame.standby === "number" ? frame.standby : 0,
    };
  }
  if (frame.type === "states" && isRecord(frame.states)) {
    const states: Record<string, Partial<BoardState>> = {};
    for (const [id, value] of Object.entries(frame.states)) {
      if (!isRecord(value)) continue;
      states[id] = viewOf(value);
    }
    return { type: "states", states };
  }
  if (frame.type === "state" && typeof frame.deviceId === "string") {
    return {
      type: "state",
      deviceId: frame.deviceId,
      ...("power" in frame ? { power: powerOf(frame.power) } : {}),
      ...("climate" in frame ? { climate: isRecord(frame.climate) ? (frame.climate as ClimateState) : null } : {}),
    };
  }
  return null;
}

/**
 * What a frame does to the board: each device it names takes what it says. The
 * hub has already decided what to say; there is nothing to decide here.
 */
export function applyBoardFrame(states: BoardStates | null, frame: BoardFrame): BoardStates | null {
  // Who is watching is not about any device's state; the board keeps it apart.
  if (frame.type === "watchers") return states;
  const next: BoardStates = { ...(states ?? {}) };
  if (frame.type === "states") {
    for (const [id, state] of Object.entries(frame.states)) next[id] = applyBoardState(next[id], state);
    return next;
  }
  const { type: _type, deviceId, ...view } = frame;
  next[deviceId] = applyBoardState(next[deviceId], view);
  return next;
}

/** The devices whose values a frame says, so an older HTTP answer does not overwrite them. A label alone is not a value. */
export function framedDevices(frame: BoardFrame): string[] {
  if (frame.type === "watchers") return [];
  if (frame.type === "state") return [frame.deviceId];
  return Object.entries(frame.states)
    .filter(([, state]) => state.power !== undefined || state.climate !== undefined)
    .map(([id]) => id);
}
