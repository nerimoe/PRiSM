import { describe, expect, it } from "bun:test";
import {
  announcedTypes,
  isShopAnnouncementType,
  legacyAnnounceSwitches,
  shopAnnouncementCatalog,
  shopAnnouncementLabel,
  switchesFor,
} from "../src/shop-announcements";

describe("shop announcement catalog", () => {
  it("names every type once and gives each a label", () => {
    const types = shopAnnouncementCatalog.map((entry) => entry.type);
    expect(new Set(types).size).toBe(types.length);
    for (const entry of shopAnnouncementCatalog) expect(shopAnnouncementLabel(entry.type)).toBe(entry.label);
    expect(isShopAnnouncementType("card")).toBe(true);
    expect(isShopAnnouncementType("card.login")).toBe(false);
  });

  it("only maps the old switches to types the catalog has", () => {
    for (const types of Object.values(legacyAnnounceSwitches))
      for (const type of types) expect(isShopAnnouncementType(type)).toBe(true);
  });

  it("reads a bot set with switches as the types they meant", () => {
    expect(announcedTypes({ announcePower: true, announceCards: true, announceCoins: false })).toEqual([
      "power.on", "power.off", "card",
    ]);
    expect(announcedTypes({})).toEqual([]);
  });

  it("lets a list win over switches and drops what the catalog does not know", () => {
    expect(announcedTypes({ announcePower: true, announceEvents: ["power.on", "nonsense", "power.on"] })).toEqual(["power.on"]);
    expect(announcedTypes({ announcePower: true, announceEvents: [] })).toEqual([]);
  });

  it("turns a switch on only when its list covers everything the switch meant", () => {
    expect(switchesFor(["card", "request.power.on"])).toEqual({
      announceIdle: false, announcePower: false, announceStarts: false, announceCards: true, announceCoins: false,
    });
    expect(switchesFor(["power.on", "power.off", "idle.reminder"]))
      .toMatchObject({ announcePower: true, announceIdle: true });
    // A list read back from its own switches says the same thing.
    const list = announcedTypes(switchesFor(["start", "request.coin"]));
    expect(list).toEqual(["start", "request.coin"]);
  });
});
