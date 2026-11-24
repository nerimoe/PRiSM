import { describe, expect, it } from "vitest";
import {
  canOperateCoin,
  capabilityConflicts,
  capabilityRequires,
  conflictingCapabilities,
  dependentCapabilities,
  deviceActionGroups,
  deviceActions,
  hasResourceLink,
  resourceCapabilities,
  isDirectConnect,
  isUnconfigured,
} from "./resource-capabilities";
import type { Resource } from "../../api";

const machine = (over: Partial<Resource> = {}): Resource => ({
  id: "m1",
  publicId: "p1",
  shopId: "s1",
  shopPublicId: "shop",
  name: "机台",
  aliases: [],
  enabled: true,
  kind: "machine",
  hasHinata: false,
  hinataUrl: null,
  homeAssistant: null,
  ttlockLockId: null,
  table: null,
  coinKey: 32,
  coinAfterSwipe: false,
  relayConnection: "external",
  ...over,
});

describe("device capability view", () => {
  it("treats a climate entity as its own capability with its own action group", () => {
    const ac = machine({
      climate: { url: "https://ha", entityId: "climate.room" },
      actions: [
        { name: "climate.on", capability: "climate" },
        { name: "climate.set_temperature", capability: "climate" },
      ],
    });
    expect(resourceCapabilities(ac)).toMatchObject({ power: false, climate: true });
    expect(isUnconfigured(ac)).toBe(false);
    expect(deviceActionGroups(ac)).toEqual([
      { capability: "climate", actions: ["climate.on", "climate.set_temperature"] },
    ]);
    expect(deviceActionGroups({ ...ac, actions: undefined })[0]!.actions).toContain("climate.set_fan_mode");
  });

  it("derives one capability per bound binding", () => {
    expect(resourceCapabilities(machine())).toEqual({
      power: false,
      climate: false,
      hinata_io: false,
      keys: false,
      coin: false,
      host: false,
      iot: false,
      door: false,
      table: false,
      bot: false,
    });
    expect(
      resourceCapabilities(
        machine({
          homeAssistant: { url: "https://ha", entityId: "switch.a" },
          ttlockLockId: 42,
          table: { capacity: 4, pricingConfigIds: [] },
          relayConnection: "embedded",
          hasKeys: true,
          keys: [{ id: "coin", name: "投币", mode: "keyboard", key: 32 }],
          coin: { keyId: "coin", cap: null, afterSwipe: false },
          host: { nodeId: "ln_m1", defaultProgram: "Game", programs: [{ name: "Game", path: "C:\\game.exe" }] },
          iot: { nodeId: "iot_m1", haWatch: true, ble: { enabled: true, beaconId: 1, txPower: -59, rssiThreshold: -75 } },
        }),
      ),
    ).toEqual({
      power: true,
      climate: false,
      hinata_io: true,
      keys: true,
      coin: true,
      host: true,
      iot: true,
      door: true,
      table: true,
      bot: false,
    });
  });

  it("enforces declarative capability conflicts, dependencies, and player-link rules", () => {
    // Bot conflicts with everything; IoT conflicts with table/door/climate; table+climate is allowed.
    expect(capabilityConflicts("bot", "power")).toBe(true);
    expect(capabilityConflicts("bot", "iot")).toBe(true);
    expect(capabilityConflicts("iot", "table")).toBe(true);
    expect(capabilityConflicts("iot", "door")).toBe(true);
    expect(capabilityConflicts("iot", "climate")).toBe(true);
    expect(capabilityConflicts("iot", "coin")).toBe(false);
    expect(capabilityConflicts("iot", "keys")).toBe(false);
    expect(capabilityConflicts("table", "climate")).toBe(false);

    // Coin requires keys, so removing keys is blocked while coin is enabled.
    expect(capabilityRequires("coin")).toEqual(["keys"]);
    const cabinetCaps = resourceCapabilities(
      machine({ hasKeys: true, coin: { keyId: "coin" } }),
    );
    expect(dependentCapabilities("keys", cabinetCaps)).toEqual(["coin"]);
    expect(conflictingCapabilities("bot", cabinetCaps)).toEqual(["keys", "coin"]);

    // Pure bot and pure IoT have no player link; plain QR and IoT+keys+coin do.
    expect(hasResourceLink(resourceCapabilities(machine()))).toBe(true);
    expect(hasResourceLink(resourceCapabilities(machine({ bot: { playerCommands: "all", readOnlyNotice: "", staffCommands: true, powerOffStaffOnly: false, doorResourceId: null, doorPasswordOnEntry: false, announceGroups: [], idleReminderMinutes: 5 } })))).toBe(false);
    expect(hasResourceLink(resourceCapabilities(machine({ iot: { nodeId: "iot_1", haWatch: true, ble: { enabled: true, beaconId: 1, txPower: -59, rssiThreshold: -75 } } })))).toBe(false);
    expect(hasResourceLink(resourceCapabilities(machine({
      iot: { nodeId: "iot_1", haWatch: true, ble: { enabled: true, beaconId: 1, txPower: -59, rssiThreshold: -75 } },
      hasKeys: true,
      keys: [{ id: "coin", name: "投币", mode: "gpio", nodeId: "iot_1", pin: 12, pulseMs: 80, activeLow: true }],
      coin: { keyId: "coin" },
    })))).toBe(true);
  });

  it("supports unified keys (GPIO & keyboard), coin, and host actions", () => {
    const arcade = machine({
      hasKeys: true,
      keys: [
        { id: "coin", name: "投币", mode: "gpio", nodeId: "iot-1", pin: 12, pulseMs: 80, activeLow: true },
        { id: "test", name: "测试", mode: "gpio", nodeId: "iot-1", pin: 14, pulseMs: 80, activeLow: true },
      ],
      coin: { keyId: "coin", feedbackNodeId: "iot-1", feedbackPin: 13, feedbackEdge: "falling", feedbackDebounceMs: 50, feedbackSignal: "cabinet.coin" },
      host: { nodeId: "l-1", defaultProgram: null, programs: [] },
      actions: [
        { name: "key.press", capability: "keys" },
        { name: "coin", capability: "coin" },
        { name: "host.switch", capability: "host" },
        { name: "host.screenshot", capability: "host" },
      ],
    });
    expect(canOperateCoin(arcade)).toBe(true);
    expect(deviceActionGroups(arcade)).toEqual([
      { capability: "keys", actions: ["key.press"] },
      { capability: "coin", actions: ["coin"] },
      { capability: "host", actions: ["host.switch", "host.screenshot"] },
    ]);
  });

  it("treats a direct connection as HINATA IO even without an external URL", () => {
    const direct = machine({ relayConnection: "embedded", hasHinata: false });
    expect(resourceCapabilities(direct).hinata_io).toBe(true);
    expect(isDirectConnect(direct)).toBe(true);
  });

  it("takes the server's word on coin, and reads an older response from the key and, for external relays, a password", () => {
    expect(canOperateCoin(machine({ hasHinata: true, hasPassword: false, coinEnabled: true }))).toBe(true);
    expect(canOperateCoin(machine({ relayConnection: "embedded", coinEnabled: false }))).toBe(false);
    const external = machine({ hasHinata: true, hasPassword: false, coinKey: 32 });
    expect(canOperateCoin(external)).toBe(false);
    expect(canOperateCoin({ ...external, hasPassword: true })).toBe(true);
    expect(canOperateCoin({ ...external, hasPassword: true, coinKey: 0 })).toBe(false);
    expect(
      canOperateCoin(
        machine({ relayConnection: "embedded", hasPassword: false, coinKey: 32 }),
      ),
    ).toBe(true);
  });

  it("offers only the actions the bound capabilities support", () => {
    expect(deviceActions(machine())).toEqual([]);
    expect(
      deviceActions(
        machine({
          homeAssistant: { url: "https://ha", entityId: "switch.a" },
          ttlockLockId: 7,
        }),
      ),
    ).toEqual(["power.on", "power.off", "door.open"]);
    expect(
      deviceActions(
        machine({
          hasHinata: true,
          hasPassword: true,
          coinKey: 32,
          coinEnabled: true,
        }),
      ),
    ).toEqual(["aime.scan", "coin"]);
  });

  it("prefers the action list the server derived from the capability catalog", () => {
    const serverDriven = machine({
      actions: [
        { name: "power.on", capability: "power" },
        { name: "aime.scan", capability: "hinata_io" },
        { name: "table.seat", capability: "table" },
      ],
      hasHinata: true,
      hasPassword: true,
      coinKey: 32,
    });
    expect(deviceActions(serverDriven)).toEqual([
      "power.on",
      "aime.scan",
      "table.seat",
    ]);
    expect(deviceActionGroups(serverDriven)).toEqual([
      { capability: "power", actions: ["power.on"] },
      { capability: "hinata_io", actions: ["aime.scan"] },
      { capability: "table", actions: ["table.seat"] },
    ]);
  });

  it("flags a device with no binding as unconfigured", () => {
    expect(isUnconfigured(machine())).toBe(true);
    expect(isUnconfigured(machine({ ttlockLockId: 5 }))).toBe(false);
  });
});
