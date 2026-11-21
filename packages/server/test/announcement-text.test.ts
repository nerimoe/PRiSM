import { describe, expect, it } from "bun:test";
import { announcementCatalog } from "@prism/core";
import { announcementFrame, announcementMessage, idleReminderMessage, idleReminderText } from "../src/resources/shop-events.js";

const place = { resourceId: "m1", resourceName: "舞萌" };
const alice = { playerId: "p1", displayName: "Alice", identities: [] };
const words = (message: unknown) => (message as Array<{ text?: string; player?: { displayName: string } }>)
  .map((part) => part.text ?? `<${part.player?.displayName}>`).join("");

describe("what the platform tells a bot to say", () => {
  it("has words for every entry in the catalog", () => {
    for (const { key } of announcementCatalog) {
      expect(words(announcementMessage({ ...place, key, player: null })).length).toBeGreaterThan(0);
    }
  });

  it("names the player as a segment, a card nobody owns, and staff", () => {
    expect(announcementMessage({ ...place, key: "card.consumed", player: alice, values: { verb: "刷卡" } }))
      .toEqual([{ text: "💳 " }, { player: alice }, { text: " 在 舞萌 刷卡" }]);
    expect(words(announcementMessage({ ...place, key: "card.consumed", player: null, values: { verb: "刷卡" } }))).toBe("💳 未绑定的卡 在 舞萌 刷卡");
    expect(words(announcementMessage({ ...place, key: "power.off.sent", player: null, via: "merchant" }))).toBe("🛑 店员 在后台关闭了 舞萌");
  });

  it("says where an attempt came from, and why it did not go through", () => {
    expect(words(announcementMessage({ ...place, key: "power.on.sent", player: alice, via: "page" }))).toBe("✅ <Alice> 在扫码页开启了 舞萌");
    expect(words(announcementMessage({ ...place, key: "coin.sent", player: alice, via: "bot" }))).toBe("🪙 <Alice> 通过 Bot 给 舞萌 投币");
    expect(words(announcementMessage({ ...place, key: "coin.auto.sent", player: alice, via: "system" }))).toBe("🪙 <Alice> 刷卡后，舞萌 自动投了一枚币");
    expect(words(announcementMessage({ ...place, key: "coin.refused", player: alice, via: "page", values: { reason: "达到机台投币上限" } })))
      .toBe("⛔ <Alice> 在扫码页投币被拒绝：达到机台投币上限");
    expect(words(announcementMessage({ ...place, key: "aime.scan.sent", player: alice, via: "page" }))).toBe("💳 <Alice> 在扫码页给 舞萌 虚拟刷卡");
  });

  it("is said in a shop's own words, which may use what the event knows", () => {
    const templates = {
      "announce.card.consumed.message": "{device} 欢迎 {player}",
      "announce.cabinet.coin.message": "{device}：投入 {coins}，余额 {credit}",
    };
    expect(announcementMessage({ ...place, key: "card.consumed", player: alice }, templates)).toEqual([{ text: "舞萌 欢迎 " }, { player: alice }]);
    expect(words(announcementMessage({ ...place, key: "cabinet.coin", player: null, values: { coins: "2", credits: "0", credit: "24" } }, templates)))
      .toBe("舞萌：投入 2，余额 24");
    // Words naming something the event does not know are not used.
    expect(announcementMessage({ ...place, key: "card.consumed", player: alice, values: { verb: "刷卡" } }, { "announce.card.consumed.message": "{unknown}" }))
      .toEqual(announcementMessage({ ...place, key: "card.consumed", player: alice, values: { verb: "刷卡" } }));
  });

  it("customizes both idle reminder reasons with current remaining minutes", () => {
    const templates = { "announce.idle.reminder.shop_empty": "本店将在 {minutes} 分钟后关机", "announce.idle.reminder.device_idle": "{devices} 将在 {minutes} 分钟后关机" };
    expect(idleReminderMessage({ reason: "shop_empty", at: 5 * 60000, devices: [] }, templates, 60000)).toEqual([{ text: "本店将在 4 分钟后关机" }]);
    expect(idleReminderMessage({ reason: "device_idle", at: 10000, devices: [{ name: "舞萌" }] }, templates, 0)).toEqual([{ text: "舞萌 将在 1 分钟后关机" }]);
  });

  it("hands a hub the announcement and when it happened, and no words of its own", () => {
    expect(announcementFrame({ ...place, key: "power.changed.on", player: null, via: "ha" }, new Date(0))).toEqual({
      ...place, key: "power.changed.on", player: null, via: "ha", at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("counts an idle reminder's minutes from when it is sent", () => {
    expect(idleReminderText({ reason: "shop_empty", at: 5 * 60_000, devices: [] }, 0)).toBe("店里没人，5 分钟后全部关机");
    expect(idleReminderText({ reason: "device_idle", at: 10_000, devices: [{ name: "舞萌" }, { name: "中二" }] }, 0))
      .toBe("舞萌、中二 闲置中，1 分钟后关机。已入场的玩家发送 keep 设备名 可以延迟");
  });
});
