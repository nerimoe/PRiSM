import { describe, expect, test } from "bun:test";
import {
  applyLiveFrame,
  deviceViewOf,
  idleLive,
  parseLiveFrame,
  type DeviceView,
  type LiveHandlers,
} from "../src/ui/use-resource-live";
import { TEMPERATURE_SETTLE_MS, type ClimateState } from "../src/ui/ClimateControls";

const cooling: ClimateState = {
  mode: "cool", modes: ["off", "cool", "heat"], temperature: 24, currentTemperature: 27,
  minTemperature: 16, maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};

function recorder() {
  const log: Array<["state", DeviceView] | ["refresh"]> = [];
  const handlers: LiveHandlers = {
    onState: (view) => log.push(["state", view]),
    onRefresh: () => log.push(["refresh"]),
  };
  return { log, handlers };
}

describe("device page frames", () => {
  test("reads the hub's frames as state, whatever older App Clips are told about watching", () => {
    expect(parseLiveFrame('{"type":"hello","watching":false,"power":"off"}')).toEqual({ type: "hello", power: "off" });
    expect(parseLiveFrame('{"type":"hello","watching":true,"power":"on","climate":null}')).toEqual({ type: "hello", power: "on", climate: null });
    expect(parseLiveFrame('{"type":"watching","watching":false,"power":"off"}')).toEqual({ type: "state", power: "off" });
    expect(parseLiveFrame('{"type":"state","power":"on"}')).toEqual({ type: "state", power: "on" });
    // A key that was not said stays out; one that was said as null means unknown.
    expect(parseLiveFrame('{"type":"hello","watching":false}')).toEqual({ type: "hello" });
    expect(parseLiveFrame('{"type":"state","power":null}')).toEqual({ type: "state", power: null });
    expect(parseLiveFrame('{"type":"state","power":"standby"}')).toEqual({ type: "state", power: null });
    expect(parseLiveFrame('{"type":"state","climate":' + JSON.stringify(cooling) + "}")).toEqual({ type: "state", climate: cooling });
    expect(parseLiveFrame('{"type":"refresh","reason":"binding"}')).toEqual({ type: "refresh", reason: "binding" });
    expect(parseLiveFrame('{"type":"mystery"}')).toBeNull();
    expect(parseLiveFrame("pong")).toBeNull();
    expect(parseLiveFrame("null")).toBeNull();
  });

  test("passes on every state the hub sends, and the greeting marks the channel as current", () => {
    const { log, handlers } = recorder();
    const greeted = applyLiveFrame(idleLive, { type: "hello", power: "off", climate: cooling }, handlers);
    expect(greeted).toEqual({ connected: true, dropped: false });
    applyLiveFrame(greeted, { type: "state", power: "on" }, handlers);
    expect(log).toEqual([["state", { power: "off", climate: cooling }], ["state", { power: "on" }]]);
  });

  test("a greeting with nothing to say about the device says nothing", () => {
    const { log, handlers } = recorder();
    expect(applyLiveFrame(idleLive, { type: "hello" }, handlers)).toEqual({ connected: true, dropped: false });
    expect(log).toEqual([]);
  });

  test("a refresh is passed on whatever the status", () => {
    const { log, handlers } = recorder();
    expect(applyLiveFrame(idleLive, { type: "refresh", reason: "binding" }, handlers)).toBe(idleLive);
    expect(log).toEqual([["refresh"]]);
  });

  test("an answer's device is read the same way, and anything else in it is ignored", () => {
    expect(deviceViewOf({ watching: true, power: "on", other: 1 })).toEqual({ power: "on" });
    expect(deviceViewOf({ climate: null })).toEqual({ climate: null });
    expect(deviceViewOf(undefined)).toEqual({});
  });
});

describe("air conditioner controls", () => {
  test("gather taps on the temperature buttons for a second", () => {
    expect(TEMPERATURE_SETTLE_MS).toBe(1000);
  });
});
