/**
 * Telling a shop's bots what they may announce. The catalog of types, and
 * which of them a bot is set to say, live in `@prism/core`
 * (`shopAnnouncementCatalog`): events come from what the shop's hardware
 * reported, requests from what someone asked the platform to do.
 *
 * Every announcement carries its `type` and `label`. Older bots read `kind`
 * instead, which is only set on the announcements they always received, so
 * they keep saying what they said before.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { botMessage, renderBotReplyTemplate, shopAnnouncementLabel, type BotMessage, type ShopAnnouncementType } from "@prism/core";
import type { Env } from "../bindings.js";
import { sendShopEvent } from "../durable-objects/shop-hub-client.js";
import type { MaintenanceNotice } from "../deployment-gate.js";

export type EventPlayer = {
  playerId: string;
  displayName: string | null;
  identities: Array<{ provider: string; subject: string }>;
};

/** `botId`: the bot whose command this was, which has answered it already. */
type Place = { resourceId: string; resourceName: string; botId?: string };

export type ShopEvent = Place & {
  type: ShopAnnouncementType;
  player: EventPlayer | null;
  /** Facts the announcement is about, such as how many coins went in. */
  detail?: Record<string, unknown>;
  /** Where what it tells came into the platform (`DeviceEventChannel`); a bot's rules may ask. */
  via?: string;
  /**
   * What to say when one line is not enough, such as a checkout's bill. Said
   * as it is unless the shop wrote its own words for the type, which may
   * place it with `{bill}`.
   */
  message?: BotMessage;
};

/** Who a player is, as a bot names them: display name and platform identities. */
export async function eventPlayer(db: D1DatabaseLike, shopId: string, playerId: string | null): Promise<EventPlayer | null> {
  if (!playerId) return null;
  const [player, identities] = await Promise.all([
    db.prepare("SELECT display_name FROM players WHERE shop_id = ? AND id = ?").bind(shopId, playerId)
      .first<{ display_name: string | null }>(),
    db.prepare("SELECT provider, subject FROM player_identities WHERE shop_id = ? AND player_id = ? AND provider NOT IN ('web-account', 'aime')")
      .bind(shopId, playerId).all<{ provider: string; subject: string }>(),
  ]);
  return { playerId, displayName: player?.display_name ?? null, identities: identities.results };
}

/** What a request asks for, as a shop calls it. */
const ACTION_WORDS: Record<string, string> = {
  "power.on": "开机", "power.off": "关机", "power.keep": "延迟关机",
  "climate.on": "开空调", "climate.off": "关空调", "climate.set_mode": "切换空调模式",
  "climate.set_temperature": "设定温度", "climate.set_fan_mode": "调整风速",
  coin: "投币", "aime.scan": "刷卡", "door.open": "开门",
};

/** Why a request was turned away, for the reasons a shop meets; otherwise the platform's own words or code. */
const REFUSAL_WORDS: Record<string, string> = {
  DEVICE_COMMAND_REQUIRES_ACTIVE_SESSION: "玩家未入场",
  COIN_COMMAND_COOLDOWN_ACTIVE: "投币冷却中",
  COIN_COOLDOWN: "投币冷却中",
  COIN_CABINET_FULL: "达到机台投币上限",
  COIN_VIA_SWIPE: "需要通过刷卡投币",
  DEVICE_POWER_OFF: "设备未开机",
  DEVICE_NOT_FOUND: "没有这个设备",
  DEVICE_DISABLED: "资源已停用",
  DEVICE_ACTION_UNSUPPORTED: "这里不支持此操作",
  SCAN_IDENTITY_NOT_BOUND_TO_PLAYER: "玩家没有绑定的卡片",
};

/** A refused request as an announcement tells it: what was asked and why not. */
export function refusalDetail(action: string, payload: Record<string, unknown>): { action: string; reason: string; code: string } {
  const code = String(payload.code ?? "");
  const message = typeof payload.message === "string" ? payload.message : "";
  return { action: ACTION_WORDS[action] ?? action, reason: REFUSAL_WORDS[code] ?? (message || code), code };
}

/** Where the player goes in `announcementText`; only used when there is one. */
const PLAYER_PLACEHOLDER = "{player}";

/**
 * What a bot says, written here so a new type or new words need no bot
 * release, with `{player}` where the player is named.
 */
export function announcementText(event: ShopEvent): string {
  const place = event.resourceName || event.resourceId;
  const who = event.player ? PLAYER_PLACEHOLDER : "未绑定的卡";
  const n = (key: string) => (typeof event.detail?.[key] === "number" ? (event.detail[key] as number) : 0);
  const text = (key: string) => String(event.detail?.[key] ?? "");
  // Who did it, for what is done by a person: the player, otherwise staff.
  const actor = event.player ? PLAYER_PLACEHOLDER : "店员";
  switch (event.type) {
    case "power.on": return `✅ ${place} 已开机`;
    case "power.off": return `🛑 ${place} 已关机`;
    case "request.power.on": return `✅ ${event.player ? PLAYER_PLACEHOLDER : "店员"} 远程开启了 ${place}`;
    case "request.power.off": return `🛑 ${event.player ? PLAYER_PLACEHOLDER : "店员"} 远程关闭了 ${place}`;
    case "request.power.idle_off": return `💤 ${place} 闲置，已自动关机`;
    case "card": return `💳 ${who} 在 ${place} ${text("verb") || "刷卡"}`;
    case "start": return `🎮 ${who} 在 ${place} 上机`;
    case "request.card": return `💳 ${who} 在 ${place} 发起虚拟刷卡`;
    case "request.coin": return `🪙 ${who} 在 ${place} ${text("verb") || "投币"}`;
    case "cabinet.coin": return `🪙 ${place} 投币 ${n("coins")} 个，当前 ${n("credit")} 币`;
    case "cabinet.consumed": return `🎮 ${place} 开局消耗 ${n("credits")} 币，剩余 ${n("credit")} 币`;
    case "cabinet.reset": return `🧾 ${place} 投币计数已清零`;
    case "idle.reminder": return `${shopAnnouncementLabel(event.type)}：${place}`;
    case "platform.maintenance": return shopAnnouncementLabel(event.type);
    case "session.started": return `🚪 ${actor} 入场`;
    case "session.stopped": return `⏹ ${actor} 停止了一项计费`;
    case "checkout.settled": return `🧾 ${actor} 结账 ${text("amount")}`;
    case "checkout.refused": return `⛔ ${actor} 结账失败：${text("reason")}`;
    case "wallet.adjusted": return `💰 ${actor} 余额调整 ${text("amount")}`;
    case "gift.redeemed": return `🎁 ${actor} 兑换了礼物`;
    case "card.bound": return `💳 ${actor} 添加了一张 ${text("card")} 卡`;
    case "request.refused": return `⛔ ${actor} ${text("action")}被拒绝：${text("reason")}`;
  }
}

/** The announcement as a bot message: the player a segment the bot names as its chat knows them. */
export function announcementMessage(event: ShopEvent, templates?: Record<string, string>, fallback?: BotMessage): BotMessage {
  const own = fallback ?? event.message;
  const [first = "", ...rest] = (own ? "" : announcementText(event)).split(PLAYER_PLACEHOLDER);
  const message = own ?? botMessage(first, ...rest.flatMap((text) => (event.player ? [event.player, text] : [text])));
  const n = (key: string) => String(typeof event.detail?.[key] === "number" ? event.detail[key] : 0);
  return renderBotReplyTemplate(`announce.${event.type}.message`, templates, message, {
    device: event.resourceName || event.resourceId,
    player: event.player ?? (event.type === "card" || event.type === "start" || event.type === "request.card" || event.type === "request.coin" ? "未绑定的卡" : "店员"),
    coins: n("coins"), credits: n("credits"), credit: n("credit"),
    amount: String(event.detail?.amount ?? ""), action: String(event.detail?.action ?? ""), reason: String(event.detail?.reason ?? ""),
    bill: event.message ?? message,
    verb: String(event.detail?.verb ?? (event.type === "card" ? "刷卡" : "投币")), card: String(event.detail?.card ?? ""),
  });
}

/** The frame a bot receives: the announcement with its label, its message and its time. */
export function shopEventFrame(event: ShopEvent, at = new Date()): Record<string, unknown> {
  // `message` is the platform's words; each bot renders its own over them, `bill` included.
  return { ...event, label: shopAnnouncementLabel(event.type), message: announcementMessage(event), at: at.toISOString(), ...(event.message ? { bill: event.message } : {}) };
}

/** What a bot says ahead of an idle power-off, `at` the power-off time. */
export function idleReminderText(
  notice: { reason: "shop_empty" | "device_idle"; at: number; devices: Array<{ name: string }> },
  now = Date.now(),
): string {
  const minutes = Math.max(1, Math.round((notice.at - now) / 60_000));
  if (notice.reason === "shop_empty") return `店里没人，${minutes} 分钟后全部关机`;
  const names = notice.devices.map((device) => device.name).join("、");
  return `${names} 闲置中，${minutes} 分钟后关机。已入场的玩家发送 keep 设备名 可以延迟`;
}

/** Idle warnings use the same per-bot templates as the shop's other news. */
export function idleReminderMessage(notice: Parameters<typeof idleReminderText>[0], templates?: Record<string, string>, now = Date.now()): BotMessage {
  return renderBotReplyTemplate(`announce.idle.reminder.${notice.reason}`, templates, botMessage(idleReminderText(notice, now)), {
    devices: notice.devices.map(device => device.name).join("、"),
    minutes: String(Math.max(1, Math.round((notice.at - now) / 60_000))),
  });
}

/** What a bot says around a deployment, in the shop's own words when it has any. */
export function maintenanceMessage(notice: MaintenanceNotice, templates?: Record<string, string>): BotMessage {
  if (notice.stage === "done") {
    return renderBotReplyTemplate("announce.platform.maintenance.done", templates, botMessage("✅ 后端维护完成，服务已恢复"));
  }
  const minutes = String(notice.minutes);
  const expected = String(notice.expectedMinutes);
  return renderBotReplyTemplate("announce.platform.maintenance.ahead", templates,
    botMessage(`🛠 ${minutes} 分钟后开始后端维护，预计 ${expected} 分钟内完成，期间暂停服务`), { minutes, expected });
}

/** Tell the shop's bots. Best effort: an event that cannot be sent is logged and dropped. */
export async function announceShopEvent(env: Env, shopId: string, event: ShopEvent): Promise<void> {
  await sendShopEvent(env, shopId, shopEventFrame(event));
}
