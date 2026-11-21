import { describe, expect, it } from "bun:test";
import {
  applyIdleEvent, dueIdle, emptyIdleTimers, idleBusy, idleScheduleOf, idleSettingsChanged, nextIdleWake, parseIdleSettings,
  RETRY_OFF_MS, setIdleEmpty, settleIdleOff,
  type IdleTimers,
} from "../src/resources/capabilities/idle-power.js";

const MIN = 60_000;
const T = 1_000_000_000;
const LEAD = 3 * MIN;

const rules = (value: unknown = { device: { enabled: true, minutes: 10, whileOccupied: "off" } }) => parseIdleSettings(value);
const machine = (id: string, power = true) => ({ key: `k:${id}`, ids: [id], power });
/** Timers of a shop with a bill open, unless said empty. */
const timers = (): IdleTimers => emptyIdleTimers();
const offKeys = (due: ReturnType<typeof dueIdle>) => due.off.map((one) => one.key);

describe("idle settings", () => {
  it("keeps both rules off until the shop turns them on", () => {
    const settings = parseIdleSettings(undefined);
    expect(settings.shopEmpty.enabled).toBe(false);
    expect(settings.device.enabled).toBe(false);
    expect(settings.device.whileOccupied).toBe("mark");
    expect(settings.keepMinutes).toBe(45);
  });

  it("reads the device rule of shops that set an idle time before it had a switch", () => {
    expect(parseIdleSettings({ device: { defaultMinutes: 20 } }).device).toMatchObject({ enabled: true, minutes: 20 });
    expect(parseIdleSettings({ device: { whileOccupied: "remind" } }).device.whileOccupied).toBe("off");
  });
});

describe("a device's idle timer", () => {
  it("starts when the device is switched on and switches it off when it runs out", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    expect(nextIdleWake(state, settings, T, null)).toBe(T + 10 * MIN);
    expect(idleScheduleOf(state, settings, T)).toEqual({ m1: T + 10 * MIN });
    expect(dueIdle(state, settings, T + 10 * MIN - 1, null)).toEqual({ warn: [], off: [], shopOff: false });
    expect(offKeys(dueIdle(state, settings, T + 10 * MIN, null))).toEqual(["k:m1"]);
  });

  it("ends when the device is switched off", () => {
    const state = timers();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    applyIdleEvent(state, { kind: "off", key: "k:m1" }, T + MIN);
    expect(state.entries).toEqual({});
    expect(nextIdleWake(state, rules(), T + MIN, null)).toBeNull();
  });

  it("starts again at a coin or an authorised card, and from the end of the stay one began", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    applyIdleEvent(state, { kind: "activity", ...machine("m1") }, T + 6 * MIN);
    expect(nextIdleWake(state, settings, T + 6 * MIN, null)).toBe(T + 16 * MIN);
    // A stay that lasts to T+40: the timer starts there.
    applyIdleEvent(state, { kind: "activity", ...machine("m1"), at: T + 40 * MIN }, T + 10 * MIN);
    expect(nextIdleWake(state, settings, T + 10 * MIN, null)).toBe(T + 50 * MIN);
    // A coin during the stay does not shorten it.
    applyIdleEvent(state, { kind: "activity", ...machine("m1") }, T + 12 * MIN);
    expect(nextIdleWake(state, settings, T + 12 * MIN, null)).toBe(T + 50 * MIN);
  });

  it("is held by keep for a time of its own, which a coin does not shorten", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    // Kept at T+5 for 45 minutes: far past the 10 minutes its idle time gives.
    applyIdleEvent(state, { kind: "activity", ...machine("m1"), until: T + 50 * MIN }, T + 5 * MIN);
    expect(idleScheduleOf(state, settings, T + 5 * MIN)).toEqual({ m1: T + 50 * MIN });
    applyIdleEvent(state, { kind: "activity", ...machine("m1") }, T + 20 * MIN);
    expect(idleScheduleOf(state, settings, T + 20 * MIN)).toEqual({ m1: T + 50 * MIN });
    // It is warned about and switched off like any other.
    expect(dueIdle(state, settings, T + 47 * MIN, LEAD).warn).toEqual([{ reason: "device_idle", keys: ["k:m1"], at: T + 50 * MIN }]);
    expect(offKeys(dueIdle(state, settings, T + 50 * MIN, LEAD))).toEqual(["k:m1"]);
    // Use after the kept time has passed counts from then, as ever.
    const later = timers();
    applyIdleEvent(later, { kind: "activity", ...machine("m1"), until: T + 45 * MIN }, T);
    applyIdleEvent(later, { kind: "activity", ...machine("m1") }, T + 60 * MIN);
    expect(idleScheduleOf(later, settings, T + 60 * MIN)).toEqual({ m1: T + 70 * MIN });
  });

  it("has a timer for a device nobody saw switch on once it is used", () => {
    const state = timers();
    applyIdleEvent(state, { kind: "activity", ...machine("m1") }, T);
    expect(offKeys(dueIdle(state, rules(), T + 10 * MIN, null))).toEqual(["k:m1"]);
  });

  it("warns first and switches off a lead later", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    expect(nextIdleWake(state, settings, T, LEAD)).toBe(T + 7 * MIN);
    expect(dueIdle(state, settings, T + 7 * MIN - 1, LEAD).warn).toEqual([]);
    expect(dueIdle(state, settings, T + 7 * MIN, LEAD)).toEqual({
      warn: [{ reason: "device_idle", keys: ["k:m1"], at: T + 10 * MIN }], off: [], shopOff: false,
    });
    // Said once.
    expect(dueIdle(state, settings, T + 8 * MIN, LEAD).warn).toEqual([]);
    expect(nextIdleWake(state, settings, T + 8 * MIN, LEAD)).toBe(T + 10 * MIN);
    expect(offKeys(dueIdle(state, settings, T + 10 * MIN, LEAD))).toEqual(["k:m1"]);
  });

  it("gives a full lead when the warning comes late", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    // Nothing woke the hub until after the time had passed.
    expect(dueIdle(state, settings, T + 30 * MIN, LEAD).warn).toEqual([{ reason: "device_idle", keys: ["k:m1"], at: T + 33 * MIN }]);
    expect(dueIdle(state, settings, T + 32 * MIN, LEAD).off).toEqual([]);
    expect(offKeys(dueIdle(state, settings, T + 33 * MIN, LEAD))).toEqual(["k:m1"]);
  });

  it("takes the warning back when the device is used after it", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    dueIdle(state, settings, T + 8 * MIN, LEAD);
    applyIdleEvent(state, { kind: "activity", ...machine("m1") }, T + 9 * MIN);
    expect(dueIdle(state, settings, T + 10 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: false });
    expect(nextIdleWake(state, settings, T + 10 * MIN, LEAD)).toBe(T + 16 * MIN);
  });

  it("only marks a device that runs out while players are in, when the owner says so", () => {
    const state = timers();
    const settings = rules({ device: { enabled: true, minutes: 10, whileOccupied: "mark" } });
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    expect(idleScheduleOf(state, settings, T)).toEqual({});
    expect(dueIdle(state, settings, T + 10 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: false });
    expect(state.entries["k:m1"]!.marked).toBe(true);
    expect(nextIdleWake(state, settings, T + 10 * MIN, LEAD)).toBeNull();
    // The last bill closes: with nobody in, the device rule switches it off, after its warning.
    setIdleEmpty(state, true, T + 20 * MIN);
    expect(dueIdle(state, settings, T + 20 * MIN, LEAD).warn).toEqual([{ reason: "device_idle", keys: ["k:m1"], at: T + 23 * MIN }]);
    expect(offKeys(dueIdle(state, settings, T + 23 * MIN, LEAD))).toEqual(["k:m1"]);
  });

  it("never times an excluded device, and none while the rule is off", () => {
    const state = timers();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    const excluded = rules({ device: { enabled: true, minutes: 10, whileOccupied: "off" }, devices: { m1: { exclude: true } } });
    expect(nextIdleWake(state, excluded, T, null)).toBeNull();
    expect(dueIdle(state, excluded, T + 60 * MIN, null).off).toEqual([]);
    expect(idleBusy(state, excluded)).toBe(false);
    expect(nextIdleWake(state, rules({}), T, null)).toBeNull();
  });

  it("keeps one timer for every resource on the same switch", () => {
    const state = timers();
    const settings = rules();
    const shared = { key: "power:x", ids: ["m1", "m2"], power: true };
    applyIdleEvent(state, { kind: "on", ...shared }, T);
    applyIdleEvent(state, { kind: "activity", ...shared }, T + 5 * MIN);
    expect(idleScheduleOf(state, settings, T + 5 * MIN)).toEqual({ m1: T + 15 * MIN, m2: T + 15 * MIN });
    expect(dueIdle(state, settings, T + 15 * MIN, null).off).toEqual([{ reason: "device_idle", key: "power:x" }]);
  });
});

describe("seats", () => {
  it("hold a table's timer until the last one is left", () => {
    const state = timers();
    const settings = rules();
    const table = machine("t1");
    applyIdleEvent(state, { kind: "on", ...table }, T);
    applyIdleEvent(state, { kind: "held", ...table, held: true }, T + MIN);
    expect(nextIdleWake(state, settings, T + MIN, null)).toBeNull();
    expect(dueIdle(state, settings, T + 5 * 60 * MIN, null).off).toEqual([]);
    applyIdleEvent(state, { kind: "held", ...table, held: false }, T + 5 * 60 * MIN);
    expect(nextIdleWake(state, settings, T + 5 * 60 * MIN, null)).toBe(T + 5 * 60 * MIN + 10 * MIN);
  });

  it("left on a table that had no timer start none", () => {
    const state = timers();
    applyIdleEvent(state, { kind: "held", ...machine("t1"), held: false }, T);
    expect(state.entries).toEqual({});
  });
});

describe("a power-off", () => {
  it("that failed is sent again later, without another warning", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    dueIdle(state, settings, T + 10 * MIN, null);
    settleIdleOff(state, "k:m1", false, T + 10 * MIN);
    expect(nextIdleWake(state, settings, T + 10 * MIN, LEAD)).toBe(T + 10 * MIN + RETRY_OFF_MS);
    expect(dueIdle(state, settings, T + 11 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: false });
    expect(dueIdle(state, settings, T + 10 * MIN + RETRY_OFF_MS, LEAD)).toEqual({
      warn: [], off: [{ reason: "device_idle", key: "k:m1" }], shopOff: false,
    });
  });

  it("that was accepted ends the timer of a device nothing reports", () => {
    const state = timers();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    settleIdleOff(state, "k:m1", true, T + 10 * MIN);
    expect(state.entries).toEqual({});
    expect(state.climateDue).toBe(true);
  });

  it("is repeated a few times for a device that still reports itself on", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1"), seen: true }, T);
    let now = T + 10 * MIN;
    let sent = 0;
    while (state.entries["k:m1"] && sent < 10) {
      expect(offKeys(dueIdle(state, settings, now, null))).toEqual(["k:m1"]);
      settleIdleOff(state, "k:m1", true, now);
      sent += 1;
      now += RETRY_OFF_MS;
    }
    expect(sent).toBe(3);
    // Its report ends the timer at once.
    applyIdleEvent(state, { kind: "on", ...machine("m2"), seen: true }, T);
    settleIdleOff(state, "k:m2", true, T + 10 * MIN);
    applyIdleEvent(state, { kind: "off", key: "k:m2" }, T + 10 * MIN + 1000);
    expect(state.entries).toEqual({});
  });
});

describe("the shop-empty timer", () => {
  const shopRule = (device: unknown = { enabled: false }) => rules({ shopEmpty: { enabled: true, minutes: 15 }, device });

  it("starts when the last bill closes, warns, and switches off everything still on", () => {
    const state = timers();
    const settings = shopRule();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    applyIdleEvent(state, { kind: "on", ...machine("m2") }, T);
    expect(nextIdleWake(state, settings, T, LEAD)).toBeNull();
    setIdleEmpty(state, true, T + MIN);
    expect(nextIdleWake(state, settings, T + MIN, LEAD)).toBe(T + 13 * MIN);
    expect(idleScheduleOf(state, settings, T + MIN)).toEqual({ m1: T + 16 * MIN, m2: T + 16 * MIN });
    expect(dueIdle(state, settings, T + 13 * MIN, LEAD)).toEqual({
      warn: [{ reason: "shop_empty", keys: ["k:m1", "k:m2"], at: T + 16 * MIN }], off: [], shopOff: false,
    });
    const due = dueIdle(state, settings, T + 16 * MIN, LEAD);
    expect(due.shopOff).toBe(true);
    expect(due.off).toEqual([{ reason: "shop_empty", key: "k:m1" }, { reason: "shop_empty", key: "k:m2" }]);
    // Once per empty stretch.
    for (const key of ["k:m1", "k:m2"]) settleIdleOff(state, key, true, T + 16 * MIN);
    expect(dueIdle(state, settings, T + 60 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: false });
    expect(nextIdleWake(state, settings, T + 60 * MIN, LEAD)).toBeNull();
  });

  it("is called off when someone enters", () => {
    const state = timers();
    const settings = shopRule();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    setIdleEmpty(state, true, T);
    dueIdle(state, settings, T + 13 * MIN, LEAD);
    setIdleEmpty(state, false, T + 14 * MIN);
    expect(dueIdle(state, settings, T + 60 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: false });
    // The next empty stretch has a timer of its own.
    setIdleEmpty(state, true, T + 2 * 60 * MIN);
    expect(nextIdleWake(state, settings, T + 2 * 60 * MIN, null)).toBe(T + 2 * 60 * MIN + 15 * MIN);
  });

  it("still runs out with nothing on, for the air conditioners", () => {
    const state = timers();
    setIdleEmpty(state, true, T);
    expect(dueIdle(state, shopRule(), T + 15 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: true });
  });

  it("leaves taken seats and excluded devices on", () => {
    const state = timers();
    const settings = rules({ shopEmpty: { enabled: true, minutes: 15 }, devices: { m3: { exclude: true } } });
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    applyIdleEvent(state, { kind: "on", ...machine("t1") }, T);
    applyIdleEvent(state, { kind: "held", ...machine("t1"), held: true }, T);
    applyIdleEvent(state, { kind: "on", ...machine("m3") }, T);
    setIdleEmpty(state, true, T);
    expect(offKeys(dueIdle(state, settings, T + 15 * MIN, null))).toEqual(["k:m1"]);
  });

  it("leaves a kept device on, to its own timer once the shop's has run out", () => {
    const state = timers();
    const settings = shopRule();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    applyIdleEvent(state, { kind: "on", ...machine("m2") }, T);
    setIdleEmpty(state, true, T);
    applyIdleEvent(state, { kind: "activity", ...machine("m2"), until: T + 45 * MIN }, T);
    expect(idleScheduleOf(state, settings, T)).toEqual({ m1: T + 15 * MIN });
    expect(dueIdle(state, settings, T + 12 * MIN, LEAD).warn).toEqual([{ reason: "shop_empty", keys: ["k:m1"], at: T + 15 * MIN }]);
    expect(offKeys(dueIdle(state, settings, T + 15 * MIN, LEAD))).toEqual(["k:m1"]);
    settleIdleOff(state, "k:m1", true, T + 15 * MIN);
    expect(idleScheduleOf(state, settings, T + 15 * MIN)).toEqual({ m2: T + 45 * MIN });
    expect(offKeys(dueIdle(state, settings, T + 45 * MIN, null))).toEqual(["k:m2"]);
  });

  it("leaves a device switched on afterwards to a timer of its own", () => {
    const state = timers();
    setIdleEmpty(state, true, T);
    dueIdle(state, shopRule(), T + 15 * MIN, null);
    // The device rule is off: the shop rule's own wait applies.
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T + 60 * MIN);
    expect(nextIdleWake(state, shopRule(), T + 60 * MIN, null)).toBe(T + 75 * MIN);
    expect(offKeys(dueIdle(state, shopRule(), T + 75 * MIN, null))).toEqual(["k:m1"]);
    // With the device rule on, that rule's.
    applyIdleEvent(state, { kind: "on", ...machine("m2") }, T + 60 * MIN);
    const both = shopRule({ enabled: true, minutes: 10, whileOccupied: "mark" });
    expect(idleScheduleOf(state, both, T + 60 * MIN)).toMatchObject({ m2: T + 70 * MIN });
  });

  it("times the devices instead of the device rule while it has not run out", () => {
    const state = timers();
    const settings = shopRule({ enabled: true, minutes: 10, whileOccupied: "off" });
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    setIdleEmpty(state, true, T + MIN);
    expect(dueIdle(state, settings, T + 12 * MIN, null).off).toEqual([]);
    expect(offKeys(dueIdle(state, settings, T + 16 * MIN, null))).toEqual(["k:m1"]);
  });
});

describe("the air conditioners", () => {
  it("go off once an idle power-off leaves nothing on", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    applyIdleEvent(state, { kind: "on", ...machine("m2") }, T + 5 * MIN);
    dueIdle(state, settings, T + 10 * MIN, null);
    settleIdleOff(state, "k:m1", true, T + 10 * MIN);
    expect(state.climateDue && !idleBusy(state, settings)).toBe(false);
    dueIdle(state, settings, T + 15 * MIN, null);
    settleIdleOff(state, "k:m2", true, T + 15 * MIN);
    expect(state.climateDue && !idleBusy(state, settings)).toBe(true);
  });

  it("wait for a cabinet without a switch, whose timer only counts", () => {
    const state = timers();
    const settings = rules();
    applyIdleEvent(state, { kind: "activity", ...machine("c1", false) }, T);
    expect(idleBusy(state, settings)).toBe(true);
    expect(idleScheduleOf(state, settings, T)).toEqual({});
    expect(dueIdle(state, settings, T + 10 * MIN, LEAD)).toEqual({ warn: [], off: [], shopOff: false });
    expect(state.entries).toEqual({});
    expect(state.climateDue).toBe(true);
  });
});

describe("editing the rules", () => {
  it("judges marked devices again", () => {
    const state = timers();
    applyIdleEvent(state, { kind: "on", ...machine("m1") }, T);
    dueIdle(state, rules({ device: { enabled: true, minutes: 10, whileOccupied: "mark" } }), T + 10 * MIN, null);
    expect(state.entries["k:m1"]!.marked).toBe(true);
    idleSettingsChanged(state);
    expect(offKeys(dueIdle(state, rules(), T + 11 * MIN, null))).toEqual(["k:m1"]);
  });
});
