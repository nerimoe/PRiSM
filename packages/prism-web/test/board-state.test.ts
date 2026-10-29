import { describe, expect, test } from "bun:test";
import {
  applyBoardAnswer,
  applyBoardFrame,
  applyBoardState,
  awaitingState,
  framedDevices,
  parseBoardFrame,
  type BoardState,
  type BoardStates,
} from "../src/ui/merchant/board-state";

const live = (power: "on" | "off"): BoardState => ({ watching: true, power });
const notLive = (power?: "on" | "off" | null): BoardState => ({ watching: false, ...(power !== undefined ? { power } : {}) });
const cooling = {
  mode: "cool", modes: ["off", "cool"], temperature: 24, currentTemperature: 27, minTemperature: 16,
  maxTemperature: 30, temperatureStep: 1, fanMode: "low", fanModes: ["auto", "low"],
};

describe("what the board shows of a device", () => {
  test("takes the label and every value it is told, whatever the label", () => {
    expect(applyBoardState(notLive("on"), live("off"))).toEqual(live("off"));
    expect(applyBoardState(live("on"), notLive("off"))).toEqual(notLive("off"));
    expect(applyBoardState(undefined, live("on"))).toEqual(live("on"));
  });

  test("keeps a value it was not told, however old", () => {
    // It was live and stopped: the label changes and the last value stays until the backend says another.
    expect(applyBoardState(live("on"), { watching: false })).toEqual(notLive("on"));
    expect(applyBoardState({ watching: false, power: "on", climate: cooling }, { power: "off" }))
      .toEqual({ watching: false, power: "off", climate: cooling });
  });

  test("tells a value not said yet from one the backend could not read", () => {
    expect(awaitingState(null, { power: true, climate: false })).toBe(true);
    expect(awaitingState(notLive(), { power: true, climate: false })).toBe(true);
    expect(awaitingState(notLive(null), { power: true, climate: false })).toBe(false);
    expect(awaitingState(notLive("on"), { power: true, climate: true })).toBe(true);
    expect(awaitingState({ watching: true, power: "on", climate: null }, { power: true, climate: true })).toBe(false);
  });
});

describe("an HTTP answer on the board", () => {
  test("fills in every device it names, live or not", () => {
    const board: BoardStates = { a: live("on"), b: notLive() };
    expect(applyBoardAnswer(board, { a: live("off"), b: notLive("on"), c: notLive(null) }, 100, {}))
      .toEqual({ a: live("off"), b: notLive("on"), c: notLive(null) });
    expect(applyBoardAnswer(null, { a: live("on") }, 100, {})).toEqual({ a: live("on") });
  });

  test("loses to whatever the hub said about a device after the question was asked", () => {
    const board: BoardStates = { a: live("off"), b: notLive("on") };
    expect(applyBoardAnswer(board, { a: live("on"), b: notLive("off") }, 100, { a: 150, b: 50 }))
      .toEqual({ a: live("off"), b: notLive("off") });
  });
});

describe("device board frames", () => {
  test("reads the hub's frames and ignores anything else", () => {
    expect(parseBoardFrame(JSON.stringify({ type: "states", states: { a: { watching: true, power: "on" }, b: { watching: false } }, liveConnections: ["ha_1"] })))
      .toEqual({ type: "states", states: { a: live("on"), b: { watching: false } } });
    expect(parseBoardFrame(JSON.stringify({ type: "states", states: { b: { watching: false, power: "off", climate: null } } })))
      .toEqual({ type: "states", states: { b: { watching: false, power: "off", climate: null } } });
    expect(parseBoardFrame('{"type":"state","deviceId":"a","power":"off"}')).toEqual({ type: "state", deviceId: "a", power: "off" });
    // A key that was not said stays out; one that was said as null means unknown.
    expect(parseBoardFrame('{"type":"state","deviceId":"a","power":null}')).toEqual({ type: "state", deviceId: "a", power: null });
    expect(parseBoardFrame('{"type":"state","deviceId":"a","power":"standby"}')).toEqual({ type: "state", deviceId: "a", power: null });
    expect(parseBoardFrame(JSON.stringify({ type: "state", deviceId: "a", climate: cooling }))).toEqual({ type: "state", deviceId: "a", climate: cooling });
    expect(parseBoardFrame('{"type":"state","deviceId":"a","climate":null}')).toEqual({ type: "state", deviceId: "a", climate: null });
    expect(parseBoardFrame('{"type":"state","power":"on"}')).toBeNull();
    expect(parseBoardFrame('{"type":"states","states":"nope"}')).toBeNull();
    expect(parseBoardFrame('{"type":"hello"}')).toBeNull();
    expect(parseBoardFrame("pong")).toBeNull();
    expect(parseBoardFrame("null")).toBeNull();
  });

  test("a change goes onto the device it names, and only what it says, whether or not it is live", () => {
    const board: BoardStates = { a: { watching: true, power: "on", climate: cooling }, b: notLive("off") };
    expect(applyBoardFrame(board, { type: "state", deviceId: "a", climate: { ...cooling, currentTemperature: 28 } }))
      .toEqual({ a: { watching: true, power: "on", climate: { ...cooling, currentTemperature: 28 } }, b: notLive("off") });
    expect(applyBoardFrame(board, { type: "state", deviceId: "a", power: null }))
      .toEqual({ a: { watching: true, power: null, climate: cooling }, b: notLive("off") });
    // What an action left a device in that nothing watches comes the same way.
    expect(applyBoardFrame(board, { type: "state", deviceId: "b", power: "on" })).toEqual({ a: board.a, b: notLive("on") });
  });

  test("the hub's labels change which devices are live without losing a value, and values follow", () => {
    const board: BoardStates = { a: live("on"), b: notLive("on") };
    const labelled = applyBoardFrame(board, { type: "states", states: { a: { watching: false }, b: { watching: false }, c: live("off") } });
    expect(labelled).toEqual({ a: notLive("on"), b: notLive("on"), c: live("off") });
    expect(applyBoardFrame(labelled, { type: "states", states: { a: notLive("off") } })).toEqual({ a: notLive("off"), b: notLive("on"), c: live("off") });
    expect(applyBoardFrame(null, { type: "states", states: { a: live("on") } })).toEqual({ a: live("on") });
  });

  test("only a frame with values counts as the hub having spoken about a device", () => {
    expect(framedDevices({ type: "states", states: { a: { watching: false }, b: notLive("on") } })).toEqual(["b"]);
    expect(framedDevices({ type: "state", deviceId: "a", power: "on" })).toEqual(["a"]);
    expect(framedDevices({ type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 })).toEqual([]);
  });

  test("who is watching is not about any device, so it leaves the device states alone", () => {
    const board: BoardStates = { a: live("on") };
    expect(applyBoardFrame(board, { type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 })).toBe(board);
    expect(applyBoardFrame(null, { type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 })).toBeNull();
  });
});

describe("the hub's word on who is watching", () => {
  test("reads each watcher by kind and how far it has got", () => {
    const frame = parseBoardFrame(JSON.stringify({
      type: "watchers",
      limit: 2,
      max: 4,
      standby: 1,
      watchers: [
        { id: "bot:1", kind: "bot", name: "前台", state: "watching" },
        { id: "m1", kind: "device", deviceId: "m1", state: "unreachable" },
      ],
    }));
    expect(frame).toEqual({
      type: "watchers",
      limit: 2,
      max: 4,
      standby: 1,
      watchers: [
        { id: "bot:1", kind: "bot", name: "前台", state: "watching" },
        { id: "m1", kind: "device", deviceId: "m1", state: "unreachable" },
      ],
    });
  });

  test("an empty list is an answer: nobody is watching", () => {
    expect(parseBoardFrame('{"type":"watchers","limit":2,"max":4,"watchers":[],"standby":0}'))
      .toEqual({ type: "watchers", limit: 2, max: 4, watchers: [], standby: 0 });
  });

  test("a state it does not know reads as starting, a bot without a name as Bot, and a malformed entry is skipped", () => {
    const frame = parseBoardFrame(JSON.stringify({
      type: "watchers",
      limit: 1,
      watchers: [
        { id: "bot:1", kind: "bot", state: "somewhere" },
        { id: "x", kind: "device", state: "watching" },
        { kind: "bot", name: "no id", state: "watching" },
        { id: "y", kind: "toaster", state: "watching" },
        "nonsense",
      ],
    }));
    expect(frame).toEqual({
      type: "watchers",
      limit: 1,
      // Without a bound from the hub, the board offers no more than what is set.
      max: 1,
      standby: 0,
      watchers: [{ id: "bot:1", kind: "bot", name: "Bot", state: "starting" }],
    });
  });

  test("a frame without a number of slots or a list is not one", () => {
    expect(parseBoardFrame('{"type":"watchers","watchers":[]}')).toBeNull();
    expect(parseBoardFrame('{"type":"watchers","limit":2}')).toBeNull();
  });
});
