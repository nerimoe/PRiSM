import { describe, expect, it } from "bun:test";
import {
  announcedTypes,
  announcementDestinations,
  isShopAnnouncementSource,
  isShopAnnouncementType,
  shopAnnouncementSources,
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

describe("where a bot says an announcement", () => {
  const staff = [{ provider: "onebot", subject: "10001" }, { provider: "kook", subject: "k9" }];

  it("sends what it announces to its channel list, as before there were rules", () => {
    const config = { announceEvents: ["card"], announceChannelIds: ["onebot:42", "onebot:43"] };
    expect(announcementDestinations(config, { type: "card", via: "relay" }, staff)).toEqual(["onebot:42", "onebot:43"]);
    expect(announcementDestinations(config, { type: "start", via: "relay" }, staff)).toEqual([]);
    // A bot still set by switches.
    expect(announcementDestinations({ announceCards: true, announceChannelIds: ["onebot:42"] }, { type: "card" }, staff)).toEqual(["onebot:42"]);
  });

  it("sends what a rule listens for to that rule's groups and to staff privately", () => {
    const config = {
      announceEvents: ["card"], announceChannelIds: ["onebot:42"],
      announceRules: [
        { events: ["checkout.settled", "request.power.on"], sources: ["page"], channelIds: ["onebot:99"], staff: true },
        { events: ["card"], sources: [], channelIds: ["onebot:42", "onebot:7"], staff: false },
      ],
    };
    // Done on a scanned page: the rule's group, then each staff member's own chat.
    expect(announcementDestinations(config, { type: "checkout.settled", via: "page" }, staff))
      .toEqual(["onebot:99", "onebot:private:10001", "kook:private:k9"]);
    // The same thing done through a bot, or with no source known, is not what the rule listens for.
    expect(announcementDestinations(config, { type: "checkout.settled", via: "bot" }, staff)).toEqual([]);
    expect(announcementDestinations(config, { type: "checkout.settled" }, staff)).toEqual([]);
    // A rule with no source named hears it from anywhere; a place named twice is told once.
    expect(announcementDestinations(config, { type: "card", via: "relay" }, staff)).toEqual(["onebot:42", "onebot:7"]);
  });

  it("names every source a device event can record", () => {
    expect(shopAnnouncementSources.map((source) => source.channel).sort())
      .toEqual(["api", "bot", "ha", "merchant", "page", "relay", "system"]);
    expect(isShopAnnouncementSource("page")).toBe(true);
    expect(isShopAnnouncementSource("phone")).toBe(false);
  });
});
