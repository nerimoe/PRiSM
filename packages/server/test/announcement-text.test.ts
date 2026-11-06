import { describe, expect, it } from "bun:test";
import { shopAnnouncementCatalog } from "@prism/core";
import { announcementMessage, announcementText, idleReminderText, shopEventFrame } from "../src/resources/shop-events.js";

const place = { resourceId: "m1", resourceName: "舞萌" };
const alice = { playerId: "p1", displayName: "Alice", identities: [] };

describe("what the platform tells a bot to say", () => {
  it("has words for every type in the catalog", () => {
    for (const { type } of shopAnnouncementCatalog) {
      expect(announcementText({ ...place, type, player: null }).length).toBeGreaterThan(0);
    }
  });

  it("leaves the player's name to the bot, and names a card nobody owns", () => {
    expect(announcementText({ ...place, type: "card", player: alice })).toBe("💳 {player} 在 舞萌 刷卡");
    expect(announcementText({ ...place, type: "card", player: null })).toBe("💳 未绑定的卡 在 舞萌 刷卡");
    expect(announcementText({ ...place, type: "request.power.off", player: null })).toBe("🛑 店员 通过平台关闭了 舞萌");
  });

  it("makes the player a segment of the message, for the bot to name", () => {
    expect(announcementMessage({ ...place, type: "card", player: alice })).toEqual([{ text: "💳 " }, { player: alice }, { text: " 在 舞萌 刷卡" }]);
    expect(announcementMessage({ ...place, type: "card", player: null })).toEqual([{ text: "💳 未绑定的卡 在 舞萌 刷卡" }]);
  });

  it("puts the facts of a cabinet's books into its words", () => {
    expect(announcementText({ ...place, type: "cabinet.swallowed", player: null, detail: { coins: 2, credit: 24 } }))
      .toBe("⚠️ 舞萌 吞了 2 个币，机台里已有 24 个");
    expect(announcementText({ ...place, type: "cabinet.consumed", player: null, detail: { credits: 1, credit: 3 } }))
      .toBe("🎮 舞萌 开局用了 1 个币，还剩 3 个");
  });

  it("sends the message with the label in every frame", () => {
    expect(shopEventFrame({ ...place, type: "power.on", player: null }, new Date(0))).toEqual({
      ...place, type: "power.on", player: null, label: "开机", message: [{ text: "✅ 舞萌 已开机" }], at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("counts an idle reminder's minutes from when it is sent", () => {
    expect(idleReminderText({ reason: "shop_empty", at: 5 * 60_000, devices: [] }, 0)).toBe("店里没人，5 分钟后全部关机");
    expect(idleReminderText({ reason: "device_idle", at: 10_000, devices: [{ name: "舞萌" }, { name: "中二" }] }, 0))
      .toBe("舞萌、中二 闲置中，1 分钟后关机。已入场的玩家发送 keep 设备名 可以延迟");
  });
});
