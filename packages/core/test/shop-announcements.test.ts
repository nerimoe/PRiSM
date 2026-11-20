import { describe, expect, it } from "bun:test";
import {
  announcementCatalog,
  announcementDestinations,
  announcementKeyOf,
  announcementLabel,
  announcementWhere,
  isAnnouncementKey,
  isShopAnnouncementSource,
  shopAnnouncementSources,
  staffDestination,
  type ShopAnnouncementRule,
} from "../src/shop-announcements";

describe("shop announcement catalog", () => {
  it("names every entry once, by the event it is", () => {
    const keys = announcementCatalog.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(isAnnouncementKey("card.consumed")).toBe(true);
    expect(isAnnouncementKey("card")).toBe(false);
    // An attempt's outcomes say which they are; a fact is just its name.
    expect(announcementLabel("power.on.sent")).toBe("开机 · 已发出");
    expect(announcementLabel("power.off.idle.sent")).toBe("闲置自动关机");
    expect(announcementLabel("power.changed.on")).toBe("设备开机");
  });

  it("tells an event under its own key, how an attempt went, and a slice the shop sees as its own", () => {
    expect(announcementKeyOf({ type: "power.on.requested" })).toBeNull();
    expect(announcementKeyOf({ type: "power.on.sent", via: "page" })).toBe("power.on.sent");
    expect(announcementKeyOf({ type: "power.on.unanswered" })).toBe("power.on.failed");
    expect(announcementKeyOf({ type: "coin.refused" })).toBe("coin.refused");
    expect(announcementKeyOf({ type: "power.off.sent", via: "system" })).toBe("power.off.idle.sent");
    expect(announcementKeyOf({ type: "coin.sent", via: "system", payload: { cause: "card" } })).toBe("coin.auto.sent");
    // Only a switch a current watcher saw happen: a first snapshot or a return from unavailable is not news.
    expect(announcementKeyOf({ type: "power.changed", payload: { to: "on", switched: { from: "off", to: "on" } } })).toBe("power.changed.on");
    expect(announcementKeyOf({ type: "climate.changed", payload: { to: { mode: "off" }, switched: { from: "on", to: "off" } } })).toBe("power.changed.off");
    expect(announcementKeyOf({ type: "power.changed", payload: { to: "on" } })).toBeNull();
    expect(announcementKeyOf({ type: "card.consumed" })).toBe("card.consumed");
    expect(announcementKeyOf({ type: "entry.refused" })).toBe("entry.refused");
    expect(announcementKeyOf({ type: "card.state" })).toBeNull();
  });

  it("says where something came from before its verb", () => {
    expect(announcementWhere("page")).toBe("在扫码页");
    expect(announcementWhere("bot")).toBe("通过 Bot ");
    expect(announcementWhere("relay")).toBe("");
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
    expect(announcementDestinations([], { key: "card.consumed", via: "relay" }, staff)).toEqual([]);
    expect(announcementDestinations([rule({ events: ["occupancy.started"], to: ["onebot:42"] })], { key: "card.consumed", via: "relay" }, staff)).toEqual([]);
  });

  it("treats a group and a person as the same kind of destination", () => {
    const rules = [rule({ events: ["card.consumed", "idle.reminder"], to: ["onebot:42", "onebot:private:10001"] })];
    expect(announcementDestinations(rules, { key: "card.consumed", via: "relay" }, staff)).toEqual(["onebot:42", "onebot:private:10001"]);
    // The idle warning is an event like any other.
    expect(announcementDestinations(rules, { key: "idle.reminder", via: "system" }, staff)).toEqual(["onebot:42", "onebot:private:10001"]);
  });

  it("names staff as whoever they are when it happens", () => {
    const rules = [rule({ events: ["checkout.settled"], to: ["onebot:99"], staff: true })];
    expect(announcementDestinations(rules, { key: "checkout.settled" }, staff))
      .toEqual(["onebot:99", "onebot:private:10001", "kook:private:k9"]);
    expect(announcementDestinations(rules, { key: "checkout.settled" }, [])).toEqual(["onebot:99"]);
    expect(staffDestination({ provider: "onebot", subject: "7" })).toBe("onebot:private:7");
  });

  it("hears a rule's events only from the sources it names, and from anywhere when it names none", () => {
    const rules = [
      rule({ events: ["checkout.settled", "power.on.sent"], sources: ["page"], staff: true }),
      rule({ events: ["card.consumed"], to: ["onebot:42"] }),
    ];
    expect(announcementDestinations(rules, { key: "checkout.settled", via: "page" }, staff))
      .toEqual(["onebot:private:10001", "kook:private:k9"]);
    // The same thing done through a bot, or with no source known, is not what the rule listens for.
    expect(announcementDestinations(rules, { key: "checkout.settled", via: "bot" }, staff)).toEqual([]);
    expect(announcementDestinations(rules, { key: "checkout.settled" }, staff)).toEqual([]);
    expect(announcementDestinations(rules, { key: "card.consumed", via: "relay" }, staff)).toEqual(["onebot:42"]);
    expect(announcementDestinations(rules, { key: "card.consumed" }, staff)).toEqual(["onebot:42"]);
  });

  it("says it once at a place several rules name, in the order the rules name them", () => {
    const rules = [
      rule({ events: ["card.consumed"], to: ["onebot:42", "onebot:private:10001"] }),
      rule({ events: ["card.consumed"], to: ["onebot:7", "onebot:42"], staff: true }),
    ];
    expect(announcementDestinations(rules, { key: "card.consumed", via: "relay" }, staff))
      .toEqual(["onebot:42", "onebot:private:10001", "onebot:7", "kook:private:k9"]);
  });
});
