import { describe, expect, it } from "vitest";
import type { Resource } from "../../api";
import { partitionDeviceSections, resolveResourceActionsLayout } from "./resource-actions-layout";

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

describe("resolveResourceActionsLayout", () => {
  it("uses compact single-column layout for 1-2 non-Launcher capabilities", () => {
    const single = resolveResourceActionsLayout(
      machine({ homeAssistant: { url: "https://ha", entityId: "switch.a" } }),
    );
    expect(single.mode).toBe("compact");
    expect(single.modalSize).toBe("default");
    expect(single.deviceSections).toEqual(["power"]);
    expect(single.hasHost).toBe(false);

    const pair = resolveResourceActionsLayout(
      machine({
        homeAssistant: { url: "https://ha", entityId: "switch.a" },
        ttlockLockId: 12,
      }),
    );
    expect(pair.mode).toBe("compact");
    expect(pair.modalSize).toBe("default");
    expect(pair.deviceSections).toEqual(["power", "door"]);
  });

  it("uses balanced two-column layout for 3+ non-Launcher capabilities", () => {
    const layout = resolveResourceActionsLayout(
      machine({
        homeAssistant: { url: "https://ha", entityId: "switch.a" },
        relayConnection: "embedded",
        hasKeys: true,
        keys: [
          { id: "coin", name: "投币", mode: "keyboard", key: 32 },
          { id: "test", name: "测试", mode: "keyboard", key: 112 },
        ],
        coin: { keyId: "coin" },
        coinEnabled: true,
      }),
    );
    expect(layout.mode).toBe("two-column");
    expect(layout.modalSize).toBe("lg");
    expect(layout.hasHost).toBe(false);
    expect(layout.deviceSections).toEqual(["power", "hinata_io", "keys", "coin"]);
  });

  it("uses dedicated host-only layout when only Launcher is enabled", () => {
    const layout = resolveResourceActionsLayout(
      machine({
        host: { nodeId: "ln_1", defaultProgram: null, programs: [] },
      }),
    );
    expect(layout.mode).toBe("host-only");
    expect(layout.modalSize).toBe("lg");
    expect(layout.hasHost).toBe(true);
    expect(layout.deviceSections).toEqual([]);
  });

  it("uses split-host xl workbench when Launcher is paired with cabinet controls", () => {
    const layout = resolveResourceActionsLayout(
      machine({
        homeAssistant: { url: "https://ha", entityId: "switch.a" },
        relayConnection: "embedded",
        hasKeys: true,
        keys: [
          { id: "coin", name: "投币", mode: "keyboard", key: 32 },
          { id: "service", name: "服务", mode: "keyboard", key: 113 },
        ],
        coin: { keyId: "coin" },
        coinEnabled: true,
        host: { nodeId: "ln_1", defaultProgram: "Game", programs: [{ name: "Game", path: "C:\\game.exe" }] },
      }),
    );
    expect(layout.mode).toBe("split-host");
    expect(layout.modalSize).toBe("xl");
    expect(layout.hasHost).toBe(true);
    expect(layout.deviceSections).toEqual(["power", "hinata_io", "keys", "coin"]);
  });
});

describe("partitionDeviceSections", () => {
  it("balances capabilities across left and right columns by weight", () => {
    expect(partitionDeviceSections(["power", "hinata_io", "keys", "coin"])).toEqual([
      ["power", "keys", "coin"],
      ["hinata_io"],
    ]);
    expect(partitionDeviceSections(["hinata_io", "keys", "coin"])).toEqual([
      ["hinata_io"],
      ["keys", "coin"],
    ]);
    expect(partitionDeviceSections(["power", "climate", "door", "table"])).toEqual([
      ["power", "door", "table"],
      ["climate"],
    ]);
  });
});
