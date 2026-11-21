/**
 * Telling a shop's bots what happened. What may be said, and the words it is
 * said in unless a shop wrote its own, are the catalog in `@prism/core`
 * (`announcementCatalog`), keyed by the events themselves; which of them a bot
 * says, and where, are its rules.
 *
 * An announcement carries its key and what its words need (`values`); each
 * bot renders it in its own words, so the platform never writes text that a
 * shop's template would only replace.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import { announcementEntry, announcementWhere, botMessage, renderBotReplyTemplate, type BotMessage } from "@prism/core";
import type { Env } from "../bindings.js";
import { sendShopEvent, type HubCalls } from "../durable-objects/shop-hub-client.js";
import type { MaintenanceNotice } from "../deployment-gate.js";

export type EventPlayer = {
  playerId: string;
  displayName: string | null;
  identities: Array<{ provider: string; subject: string }>;
};

/**
 * One thing a bot may say. `key` is its entry in the catalog; `values` fills
 * the words' `{…}` beyond the player, the device and where it came from.
 * `botId`: the bot whose command this was, which has answered it already.
 */
export type Announcement = {
  key: string;
  resourceId: string;
  resourceName: string;
  player: EventPlayer | null;
  /** Where what it tells came into the platform (`DeviceEventChannel`); a bot's rules may ask. */
  via?: string | null;
  botId?: string;
  values?: Record<string, string | BotMessage>;
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

/** Why something was turned away, for the reasons a shop meets; otherwise the platform's own words or code. */
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
  INSUFFICIENT_BALANCE: "余额不足",
  INSUFFICIENT_RECHARGE_BALANCE: "充值后余额仍不足",
  PLAYER_SESSION_OUTSIDE_BILLABLE_TIME: "当前不在营业时段",
};

/** Why an attempt was refused or failed, in the words the player is told, or the platform's own. */
export function attemptReason(payload: Record<string, unknown>): string {
  const code = String(payload.code ?? "");
  const message = typeof payload.message === "string" ? payload.message : "";
  return REFUSAL_WORDS[code] ?? (message || code || "设备没有响应");
}

/** Who a fact without a known player is about: a card nobody here owns. Anything else was staff. */
const NOBODY: Record<string, string> = { "card.consumed": "未绑定的卡" };

/**
 * An announcement in a bot's words: the shop's own for its key when it wrote
 * some, otherwise the catalog's. The player is a segment the bot names as its
 * chat knows them.
 */
export function announcementMessage(announcement: Announcement, templates?: Record<string, string>): BotMessage {
  const entry = announcementEntry(announcement.key);
  const template = `announce.${announcement.key}.message`;
  const values = {
    player: announcement.player ?? NOBODY[announcement.key] ?? "店员",
    device: announcement.resourceName || announcement.resourceId,
    where: announcementWhere(announcement.via),
    ...announcement.values,
  };
  const fallback = renderBotReplyTemplate(template, { [template]: entry?.text ?? announcement.key }, botMessage(entry?.text ?? announcement.key), values);
  return renderBotReplyTemplate(template, templates, fallback, values);
}

/** The frame a bot's hub is handed: the announcement and when it happened. */
export function announcementFrame(announcement: Announcement, at = new Date()): Record<string, unknown> {
  return { ...announcement, at: at.toISOString() };
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
export async function announce(env: Env, shopId: string, announcement: Announcement, hub?: HubCalls, at?: Date): Promise<void> {
  await sendShopEvent(env, shopId, announcementFrame(announcement, at), hub);
}
