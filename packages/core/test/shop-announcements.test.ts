import { describe, expect, it } from "bun:test";
import {
  announcementDestinations,
  isShopAnnouncementSource,
  isShopAnnouncementType,
  shopAnnouncementCatalog,
  shopAnnouncementLabel,
  shopAnnouncementSources,
  staffDestination,
  type ShopAnnouncementRule,
} from "../src/shop-announcements";

describe("shop announcement catalog", () => {
  it("names every type once and gives each a label", () => {
    const types = shopAnnouncementCatalog.map((entry) => entry.type);
    expect(new Set(types).size).toBe(types.length);
    for (const entry of shopAnnouncementCatalog) expect(shopAnnouncementLabel(entry.type)).toBe(entry.label);
    expect(isShopAnnouncementType("card")).toBe(true);
    expect(isShopAnnouncementType("card.login")).toBe(false);
  });

  it("names every source a device event can record", () => {
    expect(shopAnnouncementSources.map((source) => source.channel).sort())
      .toEqual(["api", "bot", "ha", "merchant", "page", "relay", "system"]);
    expect(isShopAnnouncementSource("page")).toBe(true);
    expect(isShopAnnouncementSource("phone")).toBe(false);
  });
});

describe("where a bot says an announcement", () => {
  const staff = [{ provider: "onebot", subject: "10001" }, { provider: "kook", subject: "k9" }];
  const rule = (rule: Partial<ShopAnnouncementRule>): ShopAnnouncementRule => ({ events: [], sources: [], to: [], staff: false, ...rule });

  it("says nothing without a rule that listens for it", () => {
    expect(announcementDestinations([], { type: "card", via: "relay" }, staff)).toEqual([]);
    expect(announcementDestinations([rule({ events: ["start"], to: ["onebot:42"] })], { type: "card", via: "relay" }, staff)).toEqual([]);
  });

  it("treats a group and a person as the same kind of destination", () => {
    const rules = [rule({ events: ["card", "idle.reminder"], to: ["onebot:42", "onebot:private:10001"] })];
    expect(announcementDestinations(rules, { type: "card", via: "relay" }, staff)).toEqual(["onebot:42", "onebot:private:10001"]);
    // The idle warning is an event like any other.
    expect(announcementDestinations(rules, { type: "idle.reminder", via: "system" }, staff)).toEqual(["onebot:42", "onebot:private:10001"]);
  });

  it("names staff as whoever they are when it happens", () => {
    const rules = [rule({ events: ["checkout.settled"], to: ["onebot:99"], staff: true })];
    expect(announcementDestinations(rules, { type: "checkout.settled" }, staff))
      .toEqual(["onebot:99", "onebot:private:10001", "kook:private:k9"]);
    expect(announcementDestinations(rules, { type: "checkout.settled" }, [])).toEqual(["onebot:99"]);
    expect(staffDestination({ provider: "onebot", subject: "7" })).toBe("onebot:private:7");
  });

  it("hears a rule's events only from the sources it names, and from anywhere when it names none", () => {
    const rules = [
      rule({ events: ["checkout.settled", "request.power.on"], sources: ["page"], staff: true }),
      rule({ events: ["card"], to: ["onebot:42"] }),
    ];
    expect(announcementDestinations(rules, { type: "checkout.settled", via: "page" }, staff))
      .toEqual(["onebot:private:10001", "kook:private:k9"]);
    // The same thing done through a bot, or with no source known, is not what the rule listens for.
    expect(announcementDestinations(rules, { type: "checkout.settled", via: "bot" }, staff)).toEqual([]);
    expect(announcementDestinations(rules, { type: "checkout.settled" }, staff)).toEqual([]);
    expect(announcementDestinations(rules, { type: "card", via: "relay" }, staff)).toEqual(["onebot:42"]);
    expect(announcementDestinations(rules, { type: "card" }, staff)).toEqual(["onebot:42"]);
  });

  it("says it once at a place several rules name, in the order the rules name them", () => {
    const rules = [
      rule({ events: ["card"], to: ["onebot:42", "onebot:private:10001"] }),
      rule({ events: ["card"], to: ["onebot:7", "onebot:42"], staff: true }),
    ];
    expect(announcementDestinations(rules, { type: "card", via: "relay" }, staff))
      .toEqual(["onebot:42", "onebot:private:10001", "onebot:7", "kook:private:k9"]);
  });
});
