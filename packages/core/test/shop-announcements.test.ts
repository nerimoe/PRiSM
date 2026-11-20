import { describe, expect, it } from "bun:test";
import {
  announcementCatalog,
  announcementDeliveries,
  announcementKeyOf,
  announcementLabel,
  announcementWhere,
  isAnnouncementKey,
  isShopAnnouncementSource,
  shopAnnouncementSources,
  type AnnouncementGroup,
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

describe("how a bot says an announcement", () => {
  const group = (group: Partial<AnnouncementGroup>): AnnouncementGroup =>
    ({ id: "g", name: "播报组", to: [], events: {}, templates: {}, ...group });
  const on = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, { on: true, sources: [] }]));

  it("says nothing a group does not hear, or hears switched off", () => {
    expect(announcementDeliveries([], { key: "card.consumed", via: "relay" })).toEqual([]);
    expect(announcementDeliveries([group({ events: on("occupancy.started"), to: ["onebot:42"] })], { key: "card.consumed" })).toEqual([]);
    expect(announcementDeliveries([group({ events: { "card.consumed": { on: false, sources: [] } }, to: ["onebot:42"] })], { key: "card.consumed" })).toEqual([]);
  });

  it("says it in the group's own words, at a group and a person alike", () => {
    const templates = { "announce.card.consumed.message": "{player} 来了" };
    expect(announcementDeliveries([group({ events: on("card.consumed"), to: ["onebot:42", "onebot:private:10001"], templates })], { key: "card.consumed" }))
      .toEqual([{ to: ["onebot:42", "onebot:private:10001"], templates }]);
  });

  it("hears an event only from the sources the group names for it, and from anywhere when it names none", () => {
    const groups = [group({ events: { "checkout.settled": { on: true, sources: ["page"] }, "card.consumed": { on: true, sources: [] } }, to: ["onebot:9"] })];
    expect(announcementDeliveries(groups, { key: "checkout.settled", via: "page" })).toHaveLength(1);
    expect(announcementDeliveries(groups, { key: "checkout.settled", via: "bot" })).toEqual([]);
    expect(announcementDeliveries(groups, { key: "checkout.settled" })).toEqual([]);
    expect(announcementDeliveries(groups, { key: "card.consumed" })).toHaveLength(1);
  });

  it("says it once per group, and once at a destination two groups name, in the first group's words", () => {
    const first = group({ id: "a", events: on("card.consumed"), to: ["onebot:42", "onebot:private:10001"], templates: { "announce.card.consumed.message": "A" } });
    const second = group({ id: "b", events: on("card.consumed"), to: ["onebot:7", "onebot:42", "kook:private:k9"], templates: { "announce.card.consumed.message": "B" } });
    expect(announcementDeliveries([first, second], { key: "card.consumed" })).toEqual([
      { to: ["onebot:42", "onebot:private:10001"], templates: first.templates },
      { to: ["onebot:7", "kook:private:k9"], templates: second.templates },
    ]);
  });
});
