import type { Resource, ResourceOccupancyView } from "../../api";
import type { ClimateState } from "../ClimateControls";
import type { BoardState } from "./board-state";
import { isDirectConnect, resourceCapabilities } from "./resource-capabilities";

/** How one status icon on a tile looks: on, off, a fault, or a value that is not known or not live. */
export type Tone = "on" | "off" | "bad" | "unsure";

export type TileView = {
  /** Lit while the power is on; a resource without power, while its own link is up or its air conditioner runs. */
  lit: boolean;
  /** The round type icon: blue while lit, red for a fault, grey otherwise. */
  tone: "on" | "off" | "bad";
  /** `live` false: the value is what was last read, not followed live; drawn hollow in its colour. */
  power: { tone: Tone; live: boolean } | null;
  climate: { tone: Tone; live: boolean; mode: string | null; temperature: number | null } | null;
  /** A direct IO: its link, and how many readers it reported (null when it never said). */
  io: { tone: Tone; readers: number | null } | null;
  /** Credits on the cabinet and its coin cap; `old` while the value is only what was last reported. */
  coins: { value: number; cap: number | null; old: boolean } | null;
  seats: { capacity: number; occupants: ResourceOccupancyView["occupants"] } | null;
  /** When the idle rules switch it off, while it is running and counting down. */
  powerOffAt: string | null;
};

/**
 * What a resource's tile shows, worked out from the device, what the board knows of its power and
 * air conditioner, and who is on it. Power and the IO are read independently: an IO connects on
 * its own, so one that is not connected is simply grey, whatever the power says.
 */
export function tileView(
  device: Resource,
  state: BoardState | null,
  occupancy: ResourceOccupancyView | undefined,
  powerOffAt: string | undefined,
  stateFailed: boolean,
): TileView {
  const caps = resourceCapabilities(device);
  const live = !!state?.watching;
  const power = !caps.power
    ? null
    : {
        tone: (stateFailed || state?.power == null ? "unsure" : state.power === "on" ? "on" : "off") as Tone,
        live,
      };
  const climateState: ClimateState | null | undefined = state?.climate;
  const climateRunning = !!climateState && climateState.mode !== "off";
  const climate = !caps.climate
    ? null
    : {
        tone: (stateFailed || !climateState ? "unsure" : climateRunning ? "on" : "off") as Tone,
        live,
        mode: climateRunning ? climateState!.mode : null,
        temperature: climateRunning ? climateState!.temperature : null,
      };
  const direct = caps.hinata_io && isDirectConnect(device);
  const linkTone: Tone = device.relayOnline === true ? "on" : device.relayOnline === false ? "off" : "unsure";
  const readers = device.io?.readers ?? null;
  const io = direct ? { tone: linkTone, readers } : null;
  // Power that is on, as far as the board knows, even when it is not live.
  const powered = caps.power ? state?.power === "on" : null;
  const lit = caps.power
    ? powered === true
    : caps.bot
      ? device.botOnline === true
      : direct
        ? device.relayOnline === true
        : caps.climate
          ? climateRunning
          : false;
  const credit = device.io?.credit;
  const coins = direct && typeof credit === "number"
    ? { value: credit, cap: device.coinCap ?? null, old: device.relayOnline !== true || powered === false }
    : null;
  const fault = !!io && io.tone === "on" && readers === 0;
  const counting = !!powerOffAt && (powered !== false || climateRunning) && (caps.power || caps.climate);
  return {
    lit,
    tone: fault ? "bad" : lit ? "on" : "off",
    power,
    climate,
    io,
    coins,
    seats: occupancy && occupancy.capacity > 0 ? { capacity: occupancy.capacity, occupants: occupancy.occupants } : null,
    powerOffAt: counting ? powerOffAt! : null,
  };
}

/** How long someone has been on, as "38 分" or "1 时 12 分". */
export function stayLength(since: string, now: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
