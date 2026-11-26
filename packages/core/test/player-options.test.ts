import { describe, expect, it } from "bun:test";
import {
  ANONYMOUS_PLAYER_LABEL,
  botMessage,
  botMessageText,
  isPlayerOptionKey,
  isPlayerVisibleOption,
  maskBotMessagePlayers,
  playerOptionsRegistry,
  resolveBotReplyTarget,
  visiblePlayerOptionDefinitions,
} from "../src/index";

describe("playerOptionsRegistry", () => {
  it("marks excludeFromReports as non-playerVisible and hides privacyMode when shop disables it", () => {
    expect(isPlayerOptionKey("excludeFromReports")).toBe(true);
    expect(isPlayerOptionKey("privacyMode")).toBe(true);
    expect(isPlayerOptionKey("unknown")).toBe(false);

    expect(playerOptionsRegistry.excludeFromReports.playerVisible).toBe(false);
    expect(playerOptionsRegistry.privacyMode.playerVisible).toBe(true);

    expect(isPlayerVisibleOption("excludeFromReports", { privacyModeEnabled: true })).toBe(false);
    expect(isPlayerVisibleOption("excludeFromReports", { privacyModeEnabled: false })).toBe(false);

    expect(isPlayerVisibleOption("privacyMode", { privacyModeEnabled: false })).toBe(false);
    expect(isPlayerVisibleOption("privacyMode", { privacyModeEnabled: true })).toBe(true);

    expect(visiblePlayerOptionDefinitions({ privacyModeEnabled: false })).toEqual([]);
    expect(visiblePlayerOptionDefinitions({ privacyModeEnabled: true }).map((item) => item.key)).toEqual([
      "privacyMode",
    ]);
  });
});

describe("maskBotMessagePlayers", () => {
  it("replaces matching player segments with anonymous label while preserving surrounding text", () => {
    const message = [
      { text: "💳 " },
      { player: { playerId: "p1", displayName: "小明", identities: [] } },
      { text: " 在 舞萌 刷卡" },
    ];
    expect(botMessageText(maskBotMessagePlayers(message, (p) => p.playerId === "p1"))).toBe(
      `💳 ${ANONYMOUS_PLAYER_LABEL} 在 舞萌 刷卡`,
    );
    expect(botMessageText(maskBotMessagePlayers(message, () => false))).toBe("💳 小明 在 舞萌 刷卡");
    expect(botMessageText(maskBotMessagePlayers(botMessage("仅文本消息"), () => true))).toBe("仅文本消息");
  });
});

describe("resolveBotReplyTarget", () => {
  it("allows all channels with default flags when no reply groups exist", () => {
    expect(resolveBotReplyTarget({}, "onebot:42")).toEqual({
      allowed: true,
      group: null,
      ignorePrivacyMode: false,
      templates: {},
    });
    expect(resolveBotReplyTarget({ replyGroups: [] }, "private:10001", "onebot")).toEqual({
      allowed: true,
      group: null,
      ignorePrivacyMode: false,
      templates: {},
    });
  });

  it("filters target groups and private chats, honors wildcard fallback, and applies group settings", () => {
    const staffGroup = {
      id: "staff-group",
      name: "店员群",
      to: ["onebot:100", "onebot:private:9001"],
      ignorePrivacyMode: true,
      templates: { "list.empty": "没有人" },
    };
    const playerGroup = {
      id: "player-group",
      name: "玩家群",
      to: ["onebot:200"],
      ignorePrivacyMode: false,
      templates: { "wallet.success": "余额 {balance}" },
    };
    const groups = [staffGroup, playerGroup];

    expect(resolveBotReplyTarget({ replyGroups: groups }, "onebot:100")).toEqual({
      allowed: true,
      group: staffGroup,
      ignorePrivacyMode: true,
      templates: { "list.empty": "没有人" },
    });
    expect(resolveBotReplyTarget({ replyGroups: groups }, "private:9001", "onebot")).toEqual({
      allowed: true,
      group: staffGroup,
      ignorePrivacyMode: true,
      templates: { "list.empty": "没有人" },
    });
    expect(resolveBotReplyTarget({ replyGroups: groups }, "onebot:200")).toEqual({
      allowed: true,
      group: playerGroup,
      ignorePrivacyMode: false,
      templates: { "wallet.success": "余额 {balance}" },
    });
    expect(resolveBotReplyTarget({ replyGroups: groups }, "onebot:999")).toEqual({
      allowed: false,
      group: null,
      ignorePrivacyMode: false,
      templates: {},
    });

    const wildcardGroup = {
      id: "rest",
      name: "其它",
      to: ["*"],
      ignorePrivacyMode: false,
      templates: { "bind.success": "ok" },
    };
    expect(
      resolveBotReplyTarget(
        { replyTemplates: { "wallet.success": "默认" }, replyGroups: [...groups, wildcardGroup] },
        "onebot:999",
      ),
    ).toEqual({
      allowed: true,
      group: wildcardGroup,
      ignorePrivacyMode: false,
      templates: { "wallet.success": "默认", "bind.success": "ok" },
    });
  });
});
