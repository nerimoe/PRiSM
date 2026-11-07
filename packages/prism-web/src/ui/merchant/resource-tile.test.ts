import { describe, expect, it } from "vitest";
import type { Resource, ResourceOccupancyView } from "../../api";
import { stayLength, tileView } from "./resource-tile";

const resource = (over: Partial<Resource> = {}): Resource => ({
  id: "m1",
  publicId: "p1",
  shopId: "s1",
  shopPublicId: "shop",
  name: "maimai",
  aliases: [],
  enabled: true,
  kind: "machine",
  hasHinata: false,
  hinataUrl: null,
  homeAssistant: null,
  ttlockLockId: null,
  mahjong: null,
  coinKey: 32,
  coinEnabled: true,
  coinAfterSwipe: false,
  relayConnection: "external",
  ...over,
} as Resource);

const ha = { url: "https://ha", entityId: "switch.cab" };
const cabinet = (over: Partial<Resource> = {}) =>
  resource({ homeAssistant: ha, relayConnection: "embedded", coinCap: 4, io: { version: "2.4.1", readers: 2, credit: 3 }, relayOnline: true, ...over });

describe("resource tile", () => {
  it("lights a tile by its power alone, and reads the IO on its own", () => {
    const on = tileView(cabinet({ relayOnline: false }), { watching: true, power: "on" }, undefined, undefined, false);
    expect(on.lit).toBe(true);
    expect(on.io).toEqual({ tone: "off", readers: 2 });
    // An IO with its own supply stays online while the cabinet is off.
    const off = tileView(cabinet(), { watching: true, power: "off" }, undefined, undefined, false);
    expect(off.lit).toBe(false);
    expect(off.io?.tone).toBe("on");
    expect(off.tone).toBe("off");
  });

  it("shows credits against the coin cap, as last reported while the IO is away or the cabinet is off", () => {
    expect(tileView(cabinet(), { watching: true, power: "on" }, undefined, undefined, false).coins).toEqual({ value: 3, cap: 4, old: false });
    expect(tileView(cabinet({ relayOnline: false }), { watching: true, power: "on" }, undefined, undefined, false).coins?.old).toBe(true);
    expect(tileView(cabinet(), { watching: true, power: "off" }, undefined, undefined, false).coins?.old).toBe(true);
    expect(tileView(cabinet({ io: { version: null, readers: null, credit: null } }), null, undefined, undefined, false).coins).toBeNull();
  });

  it("calls only an online IO without a reader a fault", () => {
    expect(tileView(cabinet({ io: { version: "2.4.1", readers: 0, credit: 0 } }), { watching: true, power: "on" }, undefined, undefined, false).tone).toBe("bad");
    expect(tileView(cabinet({ relayOnline: false, io: { version: "2.4.1", readers: 0, credit: 0 } }), { watching: true, power: "on" }, undefined, undefined, false).tone).toBe("on");
  });

  it("keeps a value that is not live in its colour, and one that is not known as unsure", () => {
    expect(tileView(cabinet(), { watching: false, power: "off" }, undefined, undefined, false).power).toEqual({ tone: "off", live: false });
    expect(tileView(cabinet(), null, undefined, undefined, true).power?.tone).toBe("unsure");
    expect(tileView(cabinet(), { watching: true }, undefined, undefined, false).power?.tone).toBe("unsure");
  });

  it("lights a resource without power by its own link, and never a door", () => {
    expect(tileView(resource({ bot: {} as Resource["bot"], botOnline: true }), null, undefined, undefined, false).lit).toBe(true);
    expect(tileView(resource({ relayConnection: "embedded", relayOnline: true }), null, undefined, undefined, false).lit).toBe(true);
    expect(tileView(resource({ ttlockLockId: 7 }), null, undefined, undefined, false).lit).toBe(false);
  });

  it("shows seats for a resource people occupy, and the countdown only while it runs", () => {
    const occupancy: ResourceOccupancyView = { resourceId: "m1", capacity: 4, source: "mahjong", occupants: [] };
    const table = resource({ homeAssistant: ha, mahjong: { capacity: 4, pricingConfigIds: [] } });
    expect(tileView(table, { watching: true, power: "on" }, occupancy, "2026-11-07T22:40:00Z", false)).toMatchObject({
      seats: { capacity: 4, occupants: [] }, powerOffAt: "2026-11-07T22:40:00Z",
    });
    expect(tileView(table, { watching: true, power: "off" }, { ...occupancy, capacity: 0 }, "2026-11-07T22:40:00Z", false)).toMatchObject({
      seats: null, powerOffAt: null,
    });
  });

  it("measures a stay in hours and minutes", () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    expect(stayLength("2026-11-07T11:22:00Z", now)).toEqual({ hours: 0, minutes: 38 });
    expect(stayLength("2026-11-07T10:48:00Z", now)).toEqual({ hours: 1, minutes: 12 });
  });
});
