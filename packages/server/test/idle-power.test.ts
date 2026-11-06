import { describe, expect, it } from "bun:test";
import { parseIdleSettings, planIdle, RETRY_OFF_MS, type IdleDevice, type IdleInputs } from "../src/resources/capabilities/idle-power.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const device = (over: Partial<IdleDevice> = {}): IdleDevice => ({
  // Occupancy supplies its expiry; an unoccupied cabinet waits 10 minutes to shut down.
  id: "m1", name: "舞萌", hasPower: true, hasClimate: false, hasUsage: false, power: "on", climate: null,
  powerTarget: null, climateTarget: null, lastClimateAutoOff: null,
  lastActivity: null, busyUntil: null, poweredOnAt: NOW - 5 * MIN, lastAutoOff: null, ...over,
});
const inputs = (over: Omit<Partial<IdleInputs>, "settings"> & { settings?: unknown } = {}): IdleInputs => ({
  now: NOW, activeEntries: 0, emptySince: null, emptyHandled: null, devices: [device()],
  reminderLeadMs: null, reminded: {}, ...over, settings: parseIdleSettings(over.settings ?? {}),
});

describe("idle power planning", () => {
  const shared = (over: Partial<IdleDevice> = {}) => [
    device({ powerTarget: "ha-1|switch.shared", poweredOnAt: NOW - 60 * MIN }),
    device({ id: "m2", name: "中二", powerTarget: "ha-1|switch.shared", poweredOnAt: NOW - 60 * MIN, ...over }),
  ];
  const offSettings = { device: { enabled: true, minutes: 10, whileOccupied: "off" } };

  it("uses the latest shared resource's free time for one warning and a common deadline", () => {
    const devices = shared({ lastActivity: NOW - 5 * MIN });
    const plan = planIdle(inputs({ settings: offSettings, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(plan).toMatchObject({ powerOff: [], powerOffAt: { m1: NOW + 5 * MIN, m2: NOW + 5 * MIN }, nextWake: NOW + 5 * MIN });
    expect(plan.remind).toEqual([{ key: "device:m1", reason: "device_idle", deviceIds: ["m1", "m2"], at: NOW + 5 * MIN }]);
    const due = planIdle(inputs({ settings: offSettings, activeEntries: 1, devices, now: NOW + 5 * MIN }));
    expect(due.powerOff).toEqual(["m1", "m2"]);
  });

  for (const activeEntries of [0, 1]) it(`protects every shared resource while one is occupied, active entries=${activeEntries}`, () => {
    const plan = planIdle(inputs({
      settings: { ...offSettings, shopEmpty: { enabled: true, minutes: 15 } }, activeEntries,
      emptySince: NOW - 60 * MIN, devices: shared({ busyUntil: Infinity }), reminderLeadMs: 5 * MIN,
    }));
    expect(plan).toMatchObject({ powerOff: [], remind: [], powerOffAt: {}, nextWake: null });
    expect(plan.emptyHandled).toBeNull();
  });

  for (const activeEntries of [0, 1]) it(`an excluded resource protects its whole supply, active entries=${activeEntries}`, () => {
    const plan = planIdle(inputs({
      settings: { ...offSettings, shopEmpty: { enabled: true }, devices: { m2: { exclude: true } } },
      activeEntries, emptySince: NOW - 60 * MIN, devices: shared(), reminderLeadMs: 5 * MIN,
    }));
    expect(plan).toMatchObject({ powerOff: [], remind: [], powerOffAt: {} });
  });

  it("does not combine equal entity ids belonging to different HA connections", () => {
    const plan = planIdle(inputs({ settings: offSettings, activeEntries: 1,
      devices: shared({ powerTarget: "ha-2|switch.shared", busyUntil: Infinity }) }));
    expect(plan.powerOff).toEqual(["m1"]);
  });

  it("shares the retry window across resources on one supply", () => {
    const plan = planIdle(inputs({ settings: offSettings, activeEntries: 1, devices: shared({ lastAutoOff: NOW - MIN }) }));
    expect(plan).toMatchObject({ powerOff: [], nextWake: NOW - MIN + RETRY_OFF_MS });
  });

  it("defers the empty-shop shutdown and its warning until the shared supply is free", () => {
    const devices = shared({ busyUntil: NOW + 4 * MIN });
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const plan = planIdle(inputs({ settings, emptySince: NOW - 60 * MIN, devices, reminderLeadMs: 5 * MIN }));
    expect(plan).toMatchObject({ powerOff: [], powerOffAt: { m1: NOW + 4 * MIN, m2: NOW + 4 * MIN }, nextWake: NOW + 4 * MIN, emptyHandled: null });
    expect(plan.remind).toEqual([expect.objectContaining({ reason: "device_idle", deviceIds: ["m1", "m2"], at: NOW + 4 * MIN })]);
    expect(planIdle(inputs({ settings, emptySince: NOW - 60 * MIN, devices, now: NOW + 4 * MIN })).powerOff).toEqual(["m1", "m2"]);
  });

  it("warns and switches off shared air conditioners from the cabinets' idle deadline", () => {
    const devices = ["m1", "m2"].map((id) => device({ id, hasPower: false, hasClimate: true, power: null,
      climate: "cool", climateTarget: "ha-1|climate.shared" }));
    devices.push(device({ id: "game", poweredOnAt: NOW - 5 * MIN }));
    const settings = { ...offSettings, devices: { game: { exclude: true } } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(plan).toMatchObject({ powerOff: [], climateOff: [], powerOffAt: { m1: NOW + 5 * MIN, m2: NOW + 5 * MIN } });
    expect(plan.remind).toEqual([{ key: "climate:m1", reason: "device_idle", deviceIds: ["m1", "m2"], at: NOW + 5 * MIN }]);
    expect(planIdle(inputs({ settings, activeEntries: 1, devices, now: NOW + 5 * MIN })).climateOff).toEqual(["m1", "m2"]);
    devices[1]!.lastClimateAutoOff = NOW;
    expect(planIdle(inputs({ settings, activeEntries: 1, devices, now: NOW + 5 * MIN })).climateOff).toEqual([]);
  });

  it("uses the cabinet's idle condition for climate instead of a separate AC clock", () => {
    const devices = [device({ hasClimate: true, climate: "heat", poweredOnAt: NOW - 60 * MIN })];
    const plan = planIdle(inputs({ settings: offSettings, activeEntries: 1, devices }));
    expect(plan).toMatchObject({ powerOff: ["m1"], climateOff: ["m1"] });
  });

  const airConditioner = () => device({ id: "ac", hasPower: false, hasClimate: true, power: null, climate: "cool" });

  for (const hasPower of [false, true]) it(`starts the climate countdown only after every cabinet's occupancy expires, power binding=${hasPower}`, () => {
    const devices = [
      airConditioner(),
      device({ id: "left", poweredOnAt: NOW - 2 * MIN }),
      device({ id: "right", poweredOnAt: NOW - 2 * MIN }),
      device({ id: "occupied", hasPower, hasUsage: true, busyUntil: NOW + 22 * MIN }),
    ];
    const check = (now: number) => planIdle(inputs({ settings: offSettings, activeEntries: 1, devices, now, reminderLeadMs: 40 * MIN }));
    const busy = check(NOW);
    expect(busy.powerOffAt).toEqual({ left: NOW + 8 * MIN, right: NOW + 8 * MIN });
    expect(busy.climateOff).toEqual([]);
    expect(busy.remind.flatMap((notice) => notice.deviceIds)).not.toContain("ac");
    const free = check(NOW + 22 * MIN);
    expect(free.powerOffAt.ac).toBe(NOW + 32 * MIN);
    expect(free.remind.flatMap((notice) => notice.deviceIds)).toContain("ac");
    expect(check(NOW + 32 * MIN).climateOff).toEqual(["ac"]);
  });

  it("waits for the empty-shop rule when there are no cabinets to observe", () => {
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices: [airConditioner()] })).climateOff).toEqual([]);
  });

  it("can switch unknown climate off once per observed stretch of cabinet idleness", () => {
    const ac = { ...airConditioner(), climate: null };
    const cabinet = device({ poweredOnAt: NOW - 60 * MIN });
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices: [ac, cabinet] })).climateOff).toEqual(["ac"]);
    ac.lastClimateAutoOff = NOW - 5 * MIN;
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices: [ac, cabinet] })).climateOff).toEqual([]);
    cabinet.lastActivity = NOW;
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices: [ac, cabinet], now: NOW + 10 * MIN })).climateOff).toEqual(["ac"]);
  });

  it("keeps climate running until the last cabinet becomes idle, even if that cabinet is excluded from power-off", () => {
    const devices = [airConditioner(), ...shared({ lastActivity: NOW - 5 * MIN })];
    const settings = { ...offSettings, devices: { m2: { exclude: true } } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(plan).toMatchObject({ powerOff: [], climateOff: [], powerOffAt: { ac: NOW + 5 * MIN }, nextWake: NOW + 5 * MIN });
    expect(plan.remind).toEqual([expect.objectContaining({ deviceIds: ["ac"], at: NOW + 5 * MIN })]);
    expect(planIdle(inputs({ settings, activeEntries: 1, devices, now: NOW + 5 * MIN })).climateOff).toEqual(["ac"]);
    devices[2]!.lastActivity = NOW;
    expect(planIdle(inputs({ settings, activeEntries: 1, devices, now: NOW + 5 * MIN })).climateOff).toEqual([]);
  });

  for (const other of [
    device({ busyUntil: Infinity }),
    device({ power: null, poweredOnAt: null }),
    device({ hasPower: false, hasUsage: true, power: null, busyUntil: Infinity }),
  ]) it(`does not shut climate off when usage cannot end yet: ${JSON.stringify(other)}`, () => {
    const plan = planIdle(inputs({ settings: offSettings, activeEntries: 1, devices: [airConditioner(), other], reminderLeadMs: 5 * MIN }));
    expect(plan.climateOff).toEqual([]);
    expect(plan.powerOffAt.ac).toBeUndefined();
    expect(plan.remind.flatMap((r) => r.deviceIds)).not.toContain("ac");
  });

  it("uses a cabinet without a power binding as part of the all-idle deadline", () => {
    const devices = [airConditioner(), device({ hasPower: false, hasUsage: true, power: null, lastActivity: NOW - 5 * MIN })];
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices })).powerOffAt.ac).toBe(NOW + 5 * MIN);
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices, now: NOW + 5 * MIN })).climateOff).toEqual(["ac"]);
  });

  it("counts powered-off cabinets as idle and keeps the keep-on policy for climate", () => {
    const devices = [airConditioner(), device({ power: "off" })];
    expect(planIdle(inputs({ settings: offSettings, activeEntries: 1, devices })).climateOff).toEqual(["ac"]);
    expect(planIdle(inputs({ settings: { device: { enabled: true, whileOccupied: "mark" } }, activeEntries: 1, devices })).climateOff).toEqual([]);
  });

  it("allows the empty-shop climate rule even before other cabinets are idle", () => {
    const plan = planIdle(inputs({ settings: { shopEmpty: { enabled: true, minutes: 15 } }, emptySince: NOW - 20 * MIN,
      devices: [airConditioner(), device({ lastActivity: NOW, busyUntil: NOW + MIN })] }));
    expect(plan.climateOff).toEqual(["ac"]);
    expect(plan.powerOff).toEqual([]);
  });

  it("does nothing until the shop turns a rule on", () => {
    const plan = planIdle(inputs({ emptySince: NOW - 60 * MIN }));
    expect(plan).toMatchObject({ powerOff: [], climateOff: [], nextWake: null });
  });

  it("switches everything off, air conditioners included, once the shop has been empty long enough", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const devices = [device({ poweredOnAt: NOW - 40 * MIN }), device({ id: "ac", hasPower: false, hasClimate: true, power: null, climate: "cool", }), device({ id: "off", power: "off" })];
    const early = planIdle(inputs({ settings, devices, emptySince: NOW - 10 * MIN }));
    expect(early.powerOff).toEqual([]);
    expect(early.nextWake).toBe(NOW + 5 * MIN);
    const due = planIdle(inputs({ settings, devices, emptySince: NOW - 15 * MIN }));
    expect(due.powerOff).toEqual(["m1"]);
    expect(due.climateOff).toEqual(["ac"]);
    // It runs once per empty period.
    expect(planIdle(inputs({ settings, devices, emptySince: NOW - 15 * MIN, emptyHandled: due.emptyHandled })).powerOff).toEqual([]);
  });

  it("never touches an excluded device", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 1 }, device: { enabled: true, whileOccupied: "off" }, devices: { m1: { exclude: true } } };
    const plan = planIdle(inputs({ settings, emptySince: NOW - 60 * MIN }));
    expect(plan.powerOff).toEqual([]);
  });

  it("counts idle time from the later of the last activity and switching on", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const fresh = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 40 * MIN, lastActivity: NOW })] }));
    expect(fresh.powerOff).toEqual([]);
    expect(fresh.nextWake).toBe(NOW + 10 * MIN);
    const stale = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 40 * MIN, lastActivity: NOW - 31 * MIN })] }));
    expect(stale.powerOff).toEqual(["m1"]);
  });

  it("follows the owner's choice while players are in", () => {
    const idle = [device({ poweredOnAt: NOW - 60 * MIN })];
    for (const [whileOccupied, off] of [["mark", []], ["remind", ["m1"]], ["off", ["m1"]]] as const) {
      const plan = planIdle(inputs({ settings: { device: { enabled: true, whileOccupied } }, activeEntries: 2, devices: idle }));
      expect(plan.powerOff).toEqual([...off]);
    }
  });

  it("switches an idle device off when the shop is empty and the shop rule is off", () => {
    const plan = planIdle(inputs({ settings: { device: { enabled: true } }, devices: [device({ poweredOnAt: NOW - 60 * MIN })] }));
    expect(plan.powerOff).toEqual(["m1"]);
  });

  it("waits the configured idle time and leaves out a device never switched off", () => {
    const settings = { device: { enabled: true, minutes: 1, whileOccupied: "off" }, devices: { m1: { exclude: true } } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 60 * MIN }), device({ id: "m2", poweredOnAt: NOW - MIN })] }));
    expect(plan.powerOff).toEqual(["m2"]);
  });

  it("never switches a device off while someone occupies it", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const stale = { poweredOnAt: NOW - 60 * MIN, lastActivity: NOW - 40 * MIN };
    // An occupant whose stay runs on keeps it busy until then.
    const held = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ ...stale, busyUntil: NOW + 3 * MIN })] }));
    // Occupancy ends in 3 minutes; publish the countdown then and shut down 10 minutes later.
    expect(held).toMatchObject({ powerOff: [], nextWake: NOW + 3 * MIN });
    // A seat has no expiry.
    expect(planIdle(inputs({ settings, activeEntries: 1, devices: [device({ ...stale, busyUntil: Infinity })] })).powerOff).toEqual([]);
    expect(planIdle(inputs({ settings, activeEntries: 1, devices: [device(stale)] })).powerOff).toEqual(["m1"]);
  });

  it("says when a device will be switched off once its countdown has started", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    // Idle since switching on 5 minutes ago: off in 5.
    const free = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 5 * MIN })] }));
    expect(free.powerOffAt).toEqual({ m1: NOW + 5 * MIN });
    // Still busy: the countdown has not started.
    expect(planIdle(inputs({ settings, activeEntries: 1, devices: [device({ busyUntil: NOW + 15 * MIN })] })).powerOffAt).toEqual({});
    // Kept on by policy while players are in: no shutdown countdown.
    const marked = planIdle(inputs({ settings: { device: { enabled: true } }, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 5 * MIN })] }));
    expect(marked.powerOffAt).toEqual({});
    // An empty shop switches everything off on its own deadline.
    const empty = planIdle(inputs({ settings: { shopEmpty: { enabled: true, minutes: 15 } }, devices: [device({ poweredOnAt: NOW - 40 * MIN })], emptySince: NOW - 10 * MIN }));
    expect(empty.powerOffAt).toEqual({ m1: NOW + 5 * MIN });
  });

  it("reads a device idle time from before idle times moved onto resources as the rule being on", () => {
    expect(parseIdleSettings({ device: { defaultMinutes: 20, whileOccupied: "remind" } }).device).toEqual({ enabled: true, minutes: 20, whileOccupied: "off" });
    expect(parseIdleSettings({ device: { enabled: true, minutes: 10, whileOccupied: "remind" } }).device).toEqual({ enabled: true, minutes: 10, whileOccupied: "off" });
    expect(parseIdleSettings({ device: { defaultMinutes: 0 } }).device.enabled).toBe(false);
  });

  it("resets the shutdown wait on activity without creating occupancy", () => {
    const plan = planIdle(inputs({ settings: { device: { enabled: true } }, activeEntries: 1, devices: [device({ lastActivity: NOW - MIN })] }));
    expect(plan.powerOff).toEqual([]);
    expect(plan.nextWake).toBe(NOW + 9 * MIN);
  });

  it("does not retry a failed automatic power-off right away", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const plan = planIdle(inputs({ settings, activeEntries: 1, devices: [device({ poweredOnAt: NOW - 60 * MIN, lastAutoOff: NOW - MIN })] }));
    expect(plan.powerOff).toEqual([]);
    expect(plan.nextWake).toBe(NOW - MIN + RETRY_OFF_MS);
  });

  it("switches a device off without knowing its state, as an unknown one may be on", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const devices = [
      device({ power: null, poweredOnAt: null }),
      device({ id: "ac", hasPower: false, hasClimate: true, power: null, climate: null }),
      device({ id: "known-off", power: "off" }),
    ];
    const due = planIdle(inputs({ settings, devices, emptySince: NOW - 15 * MIN }));
    expect(due.powerOff).toEqual(["m1"]);
    expect(due.climateOff).toEqual(["ac"]);
  });

  it("judges a device of unknown state only by its own activity, and switches it off once per stretch of idleness", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const blind = (over: Partial<IdleDevice>) => planIdle(inputs({ settings, activeEntries: 1, devices: [device({ power: null, poweredOnAt: null, ...over })] }));
    // No activity at all: nothing to count from.
    expect(blind({}).powerOff).toEqual([]);
    expect(blind({ lastActivity: NOW })).toMatchObject({ powerOff: [], nextWake: NOW + 10 * MIN });
    expect(blind({ lastActivity: NOW - 31 * MIN }).powerOff).toEqual(["m1"]);
    // Already switched off since that activity: nothing shows whether it took, so it is left alone.
    const handled = blind({ lastActivity: NOW - 31 * MIN, lastAutoOff: NOW - 11 * MIN });
    expect(handled.powerOff).toEqual([]);
    // Fresh activity after the last switch-off starts a new stretch.
    expect(blind({ lastActivity: NOW - 31 * MIN, lastAutoOff: NOW - 40 * MIN }).powerOff).toEqual(["m1"]);
  });

  it("reminds the bot once, its lead time before the power-off", () => {
    const settings = { shopEmpty: { enabled: true, minutes: 15 } };
    const devices = [device({ poweredOnAt: NOW - 40 * MIN })];
    const before = planIdle(inputs({ settings, devices, emptySince: NOW - 5 * MIN, reminderLeadMs: 5 * MIN }));
    expect(before.remind).toEqual([]);
    expect(before.nextWake).toBe(NOW + 5 * MIN);
    const due = planIdle(inputs({ settings, devices, emptySince: NOW - 11 * MIN, reminderLeadMs: 5 * MIN }));
    expect(due.remind).toEqual([{ key: `empty:${NOW - 11 * MIN}`, reason: "shop_empty", deviceIds: ["m1"], at: NOW + 4 * MIN }]);
    const again = planIdle(inputs({ settings, devices, emptySince: NOW - 11 * MIN, reminderLeadMs: 5 * MIN, reminded: { [due.remind[0]!.key]: due.remind[0]!.at } }));
    expect(again.remind).toEqual([]);
  });

  it("only warns about devices whose rule will switch them off, including old reminder settings", () => {
    const devices = [device({ poweredOnAt: NOW - 8 * MIN })];
    const mark = planIdle(inputs({ settings: { device: { enabled: true, whileOccupied: "mark" } }, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(mark.remind).toEqual([]);
    const remind = planIdle(inputs({ settings: { device: { enabled: true, whileOccupied: "remind" } }, activeEntries: 1, devices, reminderLeadMs: 5 * MIN }));
    expect(remind.remind.map((r) => r.reason)).toEqual(["device_idle"]);
    expect(remind.powerOffAt).toEqual({ m1: NOW + 2 * MIN });
    const deadline = remind.remind[0]!.at;
    const due = planIdle(inputs({
      settings: { device: { enabled: true, whileOccupied: "remind" } }, activeEntries: 1, devices,
      now: deadline, reminderLeadMs: 5 * MIN, reminded: { "device:m1": deadline },
    }));
    expect(due.powerOff).toEqual(["m1"]);
    expect(due.remind).toEqual([]);
  });

  it("moves both the warning and power-off deadline when a device is kept on after a warning", () => {
    const settings = { device: { enabled: true, whileOccupied: "off" } };
    const warned = { "device:m1": NOW + 2 * MIN };
    const devices = [device({ poweredOnAt: NOW - 8 * MIN, lastActivity: NOW })];
    const kept = planIdle(inputs({ settings, activeEntries: 1, devices, reminded: warned, reminderLeadMs: 5 * MIN }));
    expect(kept).toMatchObject({ powerOff: [], remind: [], nextWake: NOW + 5 * MIN });
    const later = planIdle(inputs({ settings, activeEntries: 1, devices, reminded: warned, reminderLeadMs: 5 * MIN, now: NOW + 5 * MIN }));
    expect(later.remind).toEqual([{ key: "device:m1", reason: "device_idle", deviceIds: ["m1"], at: NOW + 10 * MIN }]);
    expect(later.nextWake).toBe(NOW + 10 * MIN);
  });
});
