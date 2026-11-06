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
import { botMessage, shopAnnouncementLabel, type BotMessage, type ShopAnnouncementType } from "@prism/core";
import type { Env } from "../bindings.js";
import { sendShopEvent } from "../durable-objects/shop-hub-client.js";

export type EventPlayer = {
  playerId: string;
  displayName: string | null;
  identities: Array<{ provider: string; subject: string }>;
};

/** `botId`: the bot whose command this was, which has answered it already. */
type Place = { resourceId: string; resourceName: string; botId?: string };

/** What older bots understand, set only on the announcements they always got. */
type LegacyKind =
  | { kind: "power"; state: "on" | "off"; by: "player" | "staff" | "system" }
  | { kind: "card"; started: boolean }
  | { kind: "coin"; started: boolean }
  | { kind: "occupancy" };

export type ShopEvent = Place & {
  type: ShopAnnouncementType;
  player: EventPlayer | null;
  /** Facts the announcement is about, such as how many coins went in. */
  detail?: Record<string, unknown>;
} & (LegacyKind | { kind?: undefined });

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
  switch (event.type) {
    case "power.on": return `✅ ${place} 已开机`;
    case "power.off": return `🛑 ${place} 已关机`;
    case "request.power.on": return `✅ ${event.player ? PLAYER_PLACEHOLDER : "店员"} 通过平台开启了 ${place}`;
    case "request.power.off": return `🛑 ${event.player ? PLAYER_PLACEHOLDER : "店员"} 通过平台关闭了 ${place}`;
    case "request.power.idle_off": return `💤 ${place} 闲置，已自动关机`;
    case "card": return `💳 ${who} 在 ${place} 刷卡`;
    case "start": return `🎮 ${who} 在 ${place} 上机`;
    case "request.card": return `💳 ${who} 通过平台在 ${place} 刷卡`;
    case "request.coin": return `🪙 ${who} 在 ${place} 投币`;
    case "cabinet.coin": return `🪙 ${place} 投币 ${n("coins")} 个，当前 ${n("credit")} 币`;
    case "cabinet.consumed": return `🎮 ${place} 开局消耗 ${n("credits")} 币，剩余 ${n("credit")} 币`;
    case "cabinet.reset": return `🧾 ${place} 投币计数已清零`;
    case "idle.reminder": return `${shopAnnouncementLabel(event.type)}：${place}`;
  }
}

/** The announcement as a bot message: the player a segment the bot names as its chat knows them. */
export function announcementMessage(event: ShopEvent): BotMessage {
  const [first = "", ...rest] = announcementText(event).split(PLAYER_PLACEHOLDER);
  return botMessage(first, ...rest.flatMap((text) => (event.player ? [event.player, text] : [text])));
}

/** The frame a bot receives: the announcement with its label, its message and its time. */
export function shopEventFrame(event: ShopEvent, at = new Date()): Record<string, unknown> {
  return { ...event, label: shopAnnouncementLabel(event.type), message: announcementMessage(event), at: at.toISOString() };
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

/** Tell the shop's bots. Best effort: an event that cannot be sent is logged and dropped. */
export async function announceShopEvent(env: Env, shopId: string, event: ShopEvent): Promise<void> {
  await sendShopEvent(env, shopId, shopEventFrame(event));
}
