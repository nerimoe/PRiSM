/**
 * What happened at the shop, for bots to announce.
 *
 * Four things are told, each once:
 *
 * - `power`: HA confirmed an on/off transition, whether through the platform,
 *   a physical switch, or an automation (`by: "ha"`).
 * - `card`: a card reached a cabinet. `started` says it also put its owner on
 *   the cabinet (上机), so one swipe is one announcement, never a swipe and a
 *   start apart.
 * - `coin`: a coin was pressed through the platform, with the same `started`.
 * - `occupancy`: someone started on a resource without a card or a coin.
 *
 * A card the platform sent is told when the platform sends it; the cabinet's
 * report of the same card afterwards is not told again. Which of these a bot
 * posts, and where, is its own setting; a bot leaves out its own card/coin
 * commands, but power confirmation goes to every bot.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import { sendShopEvent } from "../durable-objects/shop-hub-client.js";

export type EventPlayer = {
  playerId: string;
  displayName: string | null;
  identities: Array<{ provider: string; subject: string }>;
};

/** `botId`: the bot whose command this was, which has answered it already. */
type Place = { resourceId: string; resourceName: string; botId?: string };

export type ShopEvent =
  | (Place & { kind: "power"; state: "on" | "off"; by: "player" | "staff" | "system" | "ha"; player: EventPlayer | null })
  | (Place & { kind: "card"; player: EventPlayer | null; started: boolean })
  | (Place & { kind: "coin"; player: EventPlayer | null; started: boolean })
  | (Place & { kind: "occupancy"; player: EventPlayer });

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

/** Tell the shop's bots. Best effort: an event that cannot be sent is logged and dropped. */
export async function announceShopEvent(env: Env, shopId: string, event: ShopEvent): Promise<void> {
  await sendShopEvent(env, shopId, { ...event, at: new Date().toISOString() });
}
