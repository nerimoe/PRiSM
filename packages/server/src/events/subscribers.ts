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
 * - what follows a bill moving for a caller that publishes no fact yet: the
 *   routes' bridge (`routes/shops/index.ts`) and a bot command still tell those
 *   players' pages and phones themselves.
 */
import type { D1DatabaseLike } from "@prism/adapter-d1";
import type { Env } from "../bindings.js";
import { refreshActivityBill } from "../durable-objects/live-activity-billing.js";
import { machinePoweredOff, pagesChanged, shopHub } from "../durable-objects/shop-hub-client.js";
import { pushSessionEvent } from "../routes/shops/live-activity-events.js";
import { capabilitySpec } from "../resources/capabilities/catalog.js";
import { createOccupancy } from "../resources/occupancy/service.js";
import { announceShopEvent, eventPlayer, type ShopEvent } from "../resources/shop-events.js";
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

/** A request the hardware took, as the bots' announcement of it. */
const REQUESTS: Record<string, "request.power.on" | "request.power.off" | "request.card" | "request.coin"> = {
  "power.on.sent": "request.power.on",
  "power.off.sent": "request.power.off",
  "aime.scan.sent": "request.card",
  "coin.sent": "request.coin",
};

/** What a cabinet's books said changed, told as it is. A credit that is not a coin is recorded only. */
const CABINET = ["cabinet.coin", "cabinet.consumed", "cabinet.reset"] as const;

/**
 * What the shop's bots may announce (`resources/shop-events.ts`): that a
 * request was taken by the hardware, that a game took a card, that someone
 * started on a resource, what a cabinet's books say.
 */
export const announcementSubscriber: AfterSubscriber<EventContext> = {
  name: "bot-announcements",
  when: "after",
  wants: [...Object.keys(REQUESTS), "card.consumed", "occupancy.started", ...CABINET],
  async run(context, heard) {
    if (context.insideHub) return;
    const ids = [...new Set(heard.map((one) => one.event.deviceId).filter((id): id is string => !!id))];
    const names = new Map((await context.db.prepare("SELECT id, name FROM machines WHERE shop_id = ? AND id IN (SELECT value FROM json_each(?))")
      .bind(context.shopId, JSON.stringify(ids)).all<{ id: string; name: string }>()).results.map((row) => [row.id, row.name]));
    const announce = (event: ShopEvent) => announceShopEvent(context.env, context.shopId, event);
    const player = (playerId: string | null) => eventPlayer(context.db, context.shopId, playerId);
    // Older bots hear a start as part of the card or coin that began it.
    const started = (one: Heard) =>
      heard.some((other) => other.type === "occupancy.started" && other.event.payload.cause === one.event.id);

    for (const one of heard) {
      const { event, type } = one;
      if (!event.deviceId) continue;
      // A bot has answered its own command already and does not announce it again.
      const botId = event.via?.channel === "bot" ? event.via.resourceId : null;
      const place = { resourceId: event.deviceId, resourceName: names.get(event.deviceId) ?? event.deviceId, ...(botId ? { botId } : {}) };
      const request = REQUESTS[type];
      if (request === "request.coin") {
        await announce({ type: request, kind: "coin", ...place, player: await player(forPlayer(one)), started: started(one) });
      } else if (request) {
        await announce({ type: request, ...place, player: await player(forPlayer(one)) });
      } else if (type === "card.consumed") {
        // The game took a card: whether it came from the reader or the platform,
        // this is when it happened, so this is where it is told.
        await announce({ type: "card", kind: "card", ...place, player: await player(event.playerId), started: started(one) });
      } else if (type === "occupancy.started") {
        const who = await player(event.playerId);
        if (!who) continue;
        // A coin and a card each said their own news; anything else that starts a stay says only this.
        const own = event.payload.causeType === "coin.sent" || event.payload.causeType === "card.consumed";
        await announce(own ? { type: "start", ...place, player: who } : { type: "start", kind: "occupancy", ...place, player: who });
      } else if ((CABINET as readonly string[]).includes(type)) {
        const { previousCredit: _credit, previousTotalCoin: _previous, totalCoin: _total, ...detail } = event.payload;
        await announce({ type: type as (typeof CABINET)[number], ...place, player: null, detail });
      }
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

/**
 * Something a device reported shows a person at it: the hub rechecks who is
 * there and when the idle rule is next due.
 */
export const idleRecheckSubscriber: AfterSubscriber<EventContext> = {
  name: "hub-idle-recheck",
  when: "after",
  wants: "*",
  async run(context, heard) {
    if (context.insideHub) return;
    const active = heard.some(({ event }) =>
      event.kind === "signal" && event.origin === "device" && capabilitySpec(event.capability)?.signals[event.name]?.activity);
    if (active) await shopHub(context.env, context.shopId)?.touch(context.shopId);
  },
};

/**
 * A player's bill or balance moved (`shop-facts.ts`): their open pages read
 * themselves again and their phones' Live Activities follow. A visit starting
 * or ending is pushed as that; anything else refreshes the running bill.
 */
export const billingSubscriber: AfterSubscriber<EventContext> = {
  name: "billing-pages",
  when: "after",
  wants: ["session.started", "session.stopped", "checkout.settled", "wallet.adjusted", "assets.adjusted", "gift.redeemed"],
  async run(context, heard) {
    const { env, shopId } = context;
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
    for (const { event, type } of heard) {
      const playerId = event.playerId;
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
  announcementSubscriber,
  powerOffSubscriber,
  idleRecheckSubscriber,
];
