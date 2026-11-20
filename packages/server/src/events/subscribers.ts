/**
 * Who listens to what happens at a shop's devices.
 *
 * Every event the device bus writes passes this list (`dispatcher.ts`). A
 * module that reacts to events is added here once, saying which event names it
 * hears and whether it must finish before the caller is answered.
 *
 * Not here, on purpose:
 * - what an action's caller is answered with (the device's state read back
 *   after a power or climate action): that is part of doing the action;
 * - what the shop hub tells from its own memory (Home Assistant power changes
 *   merged per switch, the idle rule's power-offs and warnings);
 * - a mahjong table's seats: joining and leaving tell the table's pages
 *   themselves (`routes/platform/mahjong.ts`).
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import { refreshActivityBill } from "../durable-objects/live-activity-billing.js";
import { machinePoweredOff, pagesChanged, shopHub } from "../durable-objects/shop-hub-client.js";
import { pushSessionEvent } from "../routes/shops/live-activity-events.js";
import { capabilitySpec } from "../resources/capabilities/catalog.js";
import { createOccupancy } from "../resources/occupancy/service.js";
import { announcementKeyOf, botMessage, yuanOf, type BotMessage, type Cents } from "@prism/core";
import { announce, attemptReason, eventPlayer } from "../resources/shop-events.js";
import { receiptMessage } from "../resources/bot-replies.js";
import { shopCurrencyName } from "../resources/bot.js";
import { capabilities } from "../resources/capabilities/catalog.js";
import type { IdleSignal } from "../resources/capabilities/idle-power.js";
import { cameOf, type AfterSubscriber, type EventSubscriber, type Heard, type InlineSubscriber } from "./dispatcher.js";

/** What a subscriber is handed besides the events: the shop they happened at. */
export type EventContext = {
  db: D1DatabaseLike;
  env: Env;
  shopId: string;
  now?: () => Date;
  /**
   * The events were written by the shop hub itself (its idle rule, its
   * watchers' reports). The hub tells its own bots and pages what it did and
   * must not be called back from inside itself, so whatever only tells the hub
   * stays quiet.
   */
  insideHub?: boolean;
  /** The client that asked for what happened: it shows it already and is not pushed its own news. */
  initiatorClientId?: string | null;
};

/** Every request a device can be asked for (`ActionName`). */
const ACTIONS = Object.values(capabilities).flatMap((spec) => Object.keys(spec.actions));

/** A request the hardware took: what a player is billed for using may have just begun. */
const SENT = ACTIONS.map((action) => `${action}.sent`);

const actionOf = (heard: Heard) => (heard.event.kind === "result" && heard.type.endsWith(".sent") ? heard.event.name : null);

/** Whom a request was for: the player who asked, or the one staff acted for. */
const forPlayer = (heard: Heard) =>
  heard.event.playerId ?? (typeof heard.event.payload.forPlayerId === "string" ? heard.event.payload.forPlayerId : null);

/**
 * Who occupies a resource (`resources/occupancy`). Inline: billing, the idle
 * rule and the roster read stays, and what it concludes is heard by the rest.
 *
 * - `occupancy.seen`: a player the resource bills was seen on it.
 * - `occupancy.started`: that player was not on it before.
 */
export const occupancySubscriber: InlineSubscriber<EventContext> = {
  name: "occupancy",
  when: "inline",
  wants: "*",
  async run(context, heard, emit) {
    const { event } = heard;
    // Only what a device's own capability did or reported says who is at it.
    if (!event.deviceId || !capabilitySpec(event.capability)) return;
    const action = actionOf(heard);
    const observed = action
      ? { kind: "action" as const, action: action as never, playerId: forPlayer(heard) }
      : event.kind === "signal"
        ? { kind: "signal" as const, name: event.name, payload: event.payload, playerId: event.playerId }
        : null;
    if (!observed) return;
    const result = await createOccupancy({ db: context.db, shopId: context.shopId, ...(context.now ? { now: context.now } : {}) })
      .observe({ resourceId: event.deviceId, event: observed });
    if (!result.counted) return;
    emit(cameOf(heard, { capability: "occupancy", name: "occupancy.seen", playerId: observed.playerId }));
    if (result.started) emit(cameOf(heard, { capability: "occupancy", name: "occupancy.started", playerId: result.started.playerId }));
  },
};

/** A card's kind as a shop calls it. */
const CARD_KINDS: Record<string, string> = { aime: "Aime", felica: "FeliCa", banapass: "Banapass", amusement_ic: "Amusement IC" };

/** How a card reached the game, as players say it: on the reader, or sent from a page or a bot. */
const cardVerb = (event: { payload: Record<string, unknown>; operationId: string | null }) =>
  (event.payload.cardFrom ?? (event.operationId ? "platform" : "reader")) === "platform" ? "虚拟刷卡" : "刷卡";

/** How a shop's bill is worded: what its money is called, and its clock. */
async function shopWords(context: EventContext): Promise<{ currency: string; timeZone: string }> {
  const [currency, row] = await Promise.all([
    shopCurrencyName(context.db, context.shopId),
    // Where the shop's clock is kept, read as the tenant middleware reads it.
    context.db.prepare(
      "SELECT json_extract(value_json, '$.timeZone') AS time_zone FROM app_settings WHERE shop_id = ? AND key = 'store.profile'",
    ).bind(context.shopId).first<{ time_zone: string | null }>(),
  ]);
  return { currency, timeZone: row?.time_zone || "Asia/Shanghai" };
}

/** A signed amount as a shop reads it: `+5`, `-2.5`. */
const signed = (amount: unknown) => (typeof amount === "number" ? `${amount > 0 ? "+" : ""}${amount}` : "");

/** The numbers a cabinet's books said, as a bot names them. */
const books = (payload: Record<string, unknown>) =>
  Object.fromEntries(["coins", "credits", "credit"].map((key) => [key, String(typeof payload[key] === "number" ? payload[key] : 0)]));

/**
 * What the shop's bots may announce: every event the catalog in `@prism/core`
 * names (`announcementKeyOf`), attempts and facts alike, told under that key
 * with what its words need. Each says where it came from, which a bot's rules
 * may ask (`ShopAnnouncementRule`).
 */
export const announcementSubscriber: AfterSubscriber<EventContext> = {
  name: "bot-announcements",
  when: "after",
  wants: "*",
  async run(context, heard) {
    if (context.insideHub) return;
    const told = heard.flatMap((one) => {
      const key = announcementKeyOf({ type: one.type, via: one.event.via?.channel ?? null, payload: one.event.payload });
      return key ? [{ one, key }] : [];
    });
    if (!told.length) return;
    const ids = [...new Set(told.map(({ one }) => one.event.deviceId).filter((id): id is string => !!id))];
    const names = new Map((await context.db.prepare("SELECT id, name FROM machines WHERE shop_id = ? AND id IN (SELECT value FROM json_each(?))")
      .bind(context.shopId, JSON.stringify(ids)).all<{ id: string; name: string }>()).results.map((row) => [row.id, row.name]));
    let shop: Promise<{ currency: string; timeZone: string }> | undefined;

    for (const { one, key } of told) {
      const { event } = one;
      const { payload } = event;
      const who = await eventPlayer(context.db, context.shopId, forPlayer(one));
      // Somebody starting on a resource is news only when the shop knows who.
      if (key === "occupancy.started" && !who) continue;
      const values: Record<string, string | BotMessage> = {};
      if (key.endsWith(".refused") || key.endsWith(".failed")) values.reason = attemptReason(payload);
      if (key === "card.consumed") values.verb = cardVerb(event);
      if (key.startsWith("cabinet.")) Object.assign(values, books(payload));
      if (key === "wallet.adjusted") values.amount = signed(payload.amount);
      if (key === "card.bound") values.card = CARD_KINDS[String(payload.type)] ?? String(payload.type ?? "");
      if (key === "checkout.settled") values.amount = String(yuanOf(payload.total as Cents));
      // A checkout is told as its bill, worded as the bot words its own checkout's; a refused one
      // by the bill as it stands when the balance fell short of it, otherwise in a line.
      if (key === "checkout.settled" || key === "checkout.refused") {
        const bill = payload.bill && typeof payload.bill === "object" ? payload.bill as Record<string, unknown> : null;
        values.bill = bill
          ? receiptMessage(bill, {
            title: key === "checkout.settled" ? "🧾 结算账单" : `⛔ 结账失败：${values.reason}`,
            preview: key === "checkout.refused", who: { player: who }, ...await (shop ??= shopWords(context)),
          })
          : key === "checkout.settled"
            ? botMessage("🧾 ", ...(who ? [who] : ["店员"]), ` 结账 ${values.amount}`)
            : botMessage("⛔ ", ...(who ? [who] : ["店员"]), ` 结账失败：${values.reason}`);
      }
      await announce(context.env, context.shopId, {
        key,
        resourceId: event.deviceId ?? "",
        resourceName: event.deviceId ? names.get(event.deviceId) ?? event.deviceId : "",
        player: who,
        via: event.via?.channel ?? null,
        // A bot has answered its own command already and does not announce it again.
        ...(event.via?.channel === "bot" && event.via.resourceId ? { botId: event.via.resourceId } : {}),
        ...(Object.keys(values).length ? { values } : {}),
      });
    }
  },
};

/**
 * A machine was told to switch off, which is all the platform can know: Home
 * Assistant answers the same whether or not it went dark. The hub starts
 * watching what the machine's IO does about it.
 */
export const powerOffSubscriber: AfterSubscriber<EventContext> = {
  name: "hub-power-off",
  when: "after",
  wants: ["power.off.sent"],
  async run(context, heard) {
    if (context.insideHub) return;
    for (const { event } of heard) {
      if (event.deviceId) await machinePoweredOff(context.env, context.shopId, event.deviceId);
    }
  },
};

/** A bill opening or closing: whether any is open is what the shop-empty timer goes by. */
const VISITS = new Set(["session.started", "session.stopped", "checkout.settled"]);

/** Paying at a cabinet, as its own books report it. */
const PAID = new Set(["cabinet.coin", "cabinet.consumed"]);

/** Requests that show someone using a device once the hardware takes them: a coin, a card sent. */
const USES = new Set(Object.values(capabilities).flatMap((spec) =>
  Object.entries(spec.actions).filter(([name, action]) => action?.countsAsPlay && !name.startsWith("power.")).map(([name]) => `${name}.sent`)));

/** What an event means to the idle timers (`resources/capabilities/idle-power.ts`), if anything. */
function idleSignalOf({ event, type }: Heard): IdleSignal | null {
  if (VISITS.has(type)) return { kind: "sessions" };
  if (!event.deviceId) return null;
  if (type === "power.on.sent") return { kind: "on", deviceId: event.deviceId };
  if (type === "power.off.sent") return { kind: "off", deviceId: event.deviceId };
  if (type === "power.keep.sent") return { kind: "keep", deviceId: event.deviceId };
  // An authorised card is one the resource bills its player for: `occupancy.seen`, their stay on it.
  if (type === "occupancy.seen") return { kind: "activity", deviceId: event.deviceId, stay: true };
  if (USES.has(type) || (event.kind === "signal" && event.origin === "device" && PAID.has(event.name)))
    return { kind: "activity", deviceId: event.deviceId };
  return null;
}

/**
 * The hub's idle timers hear what moves them and nothing else: a device
 * switched on starts its timer, switched off ends it, a coin or an authorised
 * card starts it again, `keep` holds it, and a bill opening or closing says
 * whether the shop is empty.
 */
export const idleTimerSubscriber: AfterSubscriber<EventContext> = {
  name: "hub-idle-timers",
  when: "after",
  wants: "*",
  async run(context, heard) {
    if (context.insideHub) return;
    const signals: IdleSignal[] = [];
    const told = new Set<string>();
    for (const one of heard) {
      const signal = idleSignalOf(one);
      const key = JSON.stringify(signal);
      if (!signal || told.has(key)) continue;
      told.add(key);
      signals.push(signal);
    }
    if (signals.length) await shopHub(context.env, context.shopId)?.idleEvents(context.shopId, signals);
  },
};

/**
 * The shop's plans, prices, assets or settings changed: every open page shows
 * them, and every bill running on a phone is priced by them.
 */
export const shopChangedSubscriber: AfterSubscriber<EventContext> = {
  name: "shop-pages",
  when: "after",
  wants: ["shop.changed"],
  async run(context) {
    const { db, env, shopId } = context;
    await pagesChanged(env, shopId, { shop: true }, "shop");
    const live = await db.prepare(
      `SELECT DISTINCT a.player_id AS playerId FROM live_activity_tokens t
       JOIN shop_player_accounts a ON a.shop_id=t.shop_id AND a.user_id=t.user_id
       WHERE t.shop_id=? AND t.session_id IS NOT NULL`,
    ).bind(shopId).all<{ playerId: string }>();
    for (const { playerId } of live.results) {
      await pagesChanged(env, shopId, { player: playerId }, "billing");
      await refreshActivityBill(env, shopId, playerId, false, true);
    }
  },
};

/**
 * A player's bill or balance moved (`shop-facts.ts`), or the hardware took a
 * request made for them: their open pages read themselves again and their
 * phones' Live Activities follow. A visit starting or ending is pushed as
 * that; anything else refreshes the running bill.
 */
export const billingSubscriber: AfterSubscriber<EventContext> = {
  name: "billing-pages",
  when: "after",
  wants: [
    "session.started", "session.stopped", "checkout.settled", "wallet.adjusted", "assets.adjusted", "gift.redeemed",
    "order.changed", "player.changed", ...SENT,
  ],
  async run(context, heard) {
    const { env, shopId } = context;
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    for (const one of heard) {
      const { event, type } = one;
      const playerId = event.kind === "result" ? forPlayer(one) : event.playerId;
      if (!playerId) continue;
      await pagesChanged(env, shopId, { player: playerId }, "billing");
      const sessionIds = type === "checkout.settled" ? ids(event.payload.sessionIds)
        : type === "session.started" || type === "session.stopped" ? ids([event.payload.sessionId]) : [];
      if (sessionIds.length) {
        await pushSessionEvent({ env }, {
          shopId, playerId, sessionIds, event: type === "session.started" ? "start" : "end",
          initiatorClientId: context.initiatorClientId ?? null,
        });
      } else {
        await refreshActivityBill(env, shopId, playerId, false, true);
      }
    }
  },
};

export const eventSubscribers: readonly EventSubscriber<EventContext>[] = [
  occupancySubscriber,
  billingSubscriber,
  shopChangedSubscriber,
  announcementSubscriber,
  powerOffSubscriber,
  idleTimerSubscriber,
];
