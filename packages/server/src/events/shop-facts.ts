/**
 * What happens at a shop that is not a device doing something: a player
 * entering, a bill settled, a balance changed, a gift redeemed.
 *
 * These are events like a device's (`device_events`, capability `shop`), heard
 * by the same subscribers (`subscribers.ts`). They are published where the
 * shop's services are handed out (`withOrigin`), from what a service answered,
 * so every caller is covered and nobody reads them back out of a URL: the
 * scanned page, the merchant board, the cashier, the HTTP API and a bot's
 * commands all reach the services through here. Nothing else tells a player's
 * pages or phone that their bill moved: a service that changes one says so
 * here, or it goes untold. Each caller says where it is
 * (`FactOrigin.via`), which is how a bot's history shows an entry made through
 * it and how the shop can be told what was done on a scanned page.
 *
 * A fact is written after the service has committed, and losing it never
 * undoes or fails what was done.
 */
import { createD1Executor, type D1DatabaseLike } from "@prism/adapter-d1";
import type { SettlePlayerCheckoutResult } from "@prism/application";
import type { DeviceEvent, DeviceEventVia } from "@prism/core";
import { createDeviceEventRepository } from "@prism/storage-sql";
import { settledAsPreview } from "../resources/bot-replies.js";
import { toPlayerCheckoutPreviewView, toPlayerCheckoutResultView } from "../routes/shops/views.js";
import { PrismDomainError } from "@prism/core";
import type { Env, PrismAppDependencies } from "../bindings.js";
import type { HubCalls } from "../durable-objects/shop-hub-client.js";
import { createEventDispatcher } from "./dispatcher.js";
import { eventSubscribers } from "./subscribers.js";
import { logger } from "../log.js";

const log = logger("events");

export const SHOP_FACTS = [
  "session.started",
  "session.stopped",
  "checkout.settled",
  "resource.visited",
  /** A player added a card at one of the shop's readers: its type, never its number. */
  "card.bound",
  /**
   * What a player or staff asked of the shop and its rules turned away, with
   * why: nothing changed. A checkout's bill keeps running.
   */
  "checkout.refused",
  "entry.refused",
  "wallet.adjust.refused",
  "redeem.refused",
  "wallet.adjusted",
  "assets.adjusted",
  "gift.redeemed",
  /** A player's order for something the shop sells was placed, fulfilled or cancelled. */
  "order.changed",
  /** A player's standing at the shop changed: created, enabled or disabled, an identity bound or removed. */
  "player.changed",
  /**
   * A player took or left a seat at a table: `resourceId` is the table, and
   * `payload.left` names the table they moved from. Their bills moved with it.
   */
  "seat.changed",
  /** The shop's idle power-off rules were edited. */
  "idle.settings.changed",
  /** The shop's own rules changed: its plans, prices, assets or settings. Nobody in particular. */
  "shop.changed",
] as const;
export type ShopFactName = (typeof SHOP_FACTS)[number];

export type ShopFact = {
  name: ShopFactName;
  /** The resource it happened at, when there is one: what a player entered through. */
  resourceId?: string | null;
  /** Whom it is about; absent for what changed for the whole shop. */
  playerId?: string | null;
  staffId?: string | null;
  payload?: Record<string, unknown>;
};

/** Where a caller of the shop's services stands. */
export type FactOrigin = {
  via: DeviceEventVia;
  /** A request's `waitUntil`: what only reacts to a fact runs after the answer. */
  defer?: (work: Promise<unknown>) => void;
  /** The client that asked, which already shows what it did and is not pushed its own news. */
  clientId?: string | null;
  /** Destination where the initiating bot answered this command, so broadcasts skip only that chat. */
  botChannel?: string | null;
};

export type FactRuntime = { db: D1DatabaseLike; env: Env; shopId: string; hub?: HubCalls };

/** Write facts and tell whoever listens. Never throws. */
export async function publishShopFacts(runtime: FactRuntime, origin: FactOrigin, facts: readonly ShopFact[]): Promise<void> {
  if (!facts.length) return;
  const at = new Date();
  const events: DeviceEvent[] = facts.map((fact) => ({
    id: crypto.randomUUID(),
    deviceId: fact.resourceId ?? null,
    capability: "shop",
    kind: "signal",
    name: fact.name,
    operationId: null,
    parentOperationId: null,
    origin: "platform",
    playerId: fact.playerId ?? null,
    staffId: fact.staffId ?? null,
    payload: fact.payload ?? {},
    occurredAt: at,
    via: origin.via,
  }));
  try {
    const written = await createDeviceEventRepository(createD1Executor(runtime.db, runtime.shopId)).record({ events });
    await createEventDispatcher({
      subscribers: eventSubscribers,
      context: {
        db: runtime.db, env: runtime.env, shopId: runtime.shopId, initiatorClientId: origin.clientId ?? null,
        ...(runtime.hub ? { hub: runtime.hub } : {}),
        ...(origin.botChannel ? { botChannel: origin.botChannel } : {}),
        ...(origin.defer ? { later: origin.defer } : {}),
      },
      ...(origin.defer ? { defer: origin.defer } : {}),
    })(written);
  } catch (error) {
    log.error(`publishing ${facts.map((fact) => fact.name).join(", ")} failed`, {
      event: "shop_fact_publish_failed",
      shopId: runtime.shopId,
      via: origin.via?.channel ?? null,
      facts: facts.map((fact) => fact.name),
      error,
    });
  }
}

const settled = (result: SettlePlayerCheckoutResult, staffId?: string | null): ShopFact => ({
  name: "checkout.settled",
  playerId: result.playerSettlement.playerId,
  ...(staffId ? { staffId } : {}),
  payload: {
    sessionIds: result.playerSettlement.sessionIds,
    subtotal: result.playerSettlement.subtotal,
    total: result.playerSettlement.total,
    ...billOf(result),
  },
});

/**
 * The bill as it was charged, in the shape a receipt is worded from: the
 * record keeps what the player paid for, and a bot can say it. A bill that
 * cannot be worded is left out; the checkout has happened all the same.
 */
function billOf(result: SettlePlayerCheckoutResult): { bill?: Record<string, unknown> } {
  try {
    return { bill: settledAsPreview(toPlayerCheckoutResultView(result)) };
  } catch (error) {
    log.error(`could not word the settled bill of player ${result.playerSettlement.playerId}`, { event: "checkout_bill_unworded", playerId: result.playerSettlement.playerId, sessionIds: result.playerSettlement.sessionIds, error });
    return {};
  }
}

/**
 * Why an attempt was turned away that is not news: there was nothing to pay,
 * the front desk's own preview went stale and is shown again, or the player is
 * asked to agree first.
 */
const NOT_REFUSALS = new Set([
  "PLAYER_HAS_NO_UNSETTLED_SESSIONS",
  "ACTIVE_SESSION_NOT_FOUND",
  "CASHIER_PREVIEW_EXPIRED",
  "CASHIER_PREVIEW_CHANGED",
  // Entering waits for the player to agree to the shop's terms: a step, not a refusal.
  "CHECKIN_CONSENT_REQUIRED",
]);

/**
 * The shop's services as one caller sees them: the same services, publishing
 * what they did from where that caller stands. Only what changes a bill or a
 * balance is wrapped; everything else is the shared instance.
 */
export function withOrigin(deps: PrismAppDependencies, runtime: FactRuntime, origin: FactOrigin): PrismAppDependencies {
  const publish = (...facts: ShopFact[]) => publishShopFacts(runtime, origin, facts);
  /** Run a service call, then say what it did. What it answers is untouched. */
  const after = <Args extends unknown[], Result>(
    call: (...args: Args) => Promise<Result>,
    facts: (result: Result, ...args: Args) => ShopFact[] | Promise<ShopFact[]>,
  ) => async (...args: Args): Promise<Result> => {
    const result = await call(...args);
    await publish(...await facts(result, ...args));
    return result;
  };
  /**
   * A call someone makes of the shop that its rules may turn away: an
   * attempt. What the rules refused (a domain error) is said as
   * `<action>.refused` with its reason, and what `more` adds (a checkout's
   * bill as it stands); then the caller hears the error as before. Anything
   * else is a fault, not a refusal, and is only passed on. What went through
   * is said by the service's facts.
   */
  const attempting = <Args extends unknown[], Result>(
    action: "checkout" | "entry" | "wallet.adjust" | "redeem",
    call: (...args: Args) => Promise<Result>,
    whose: (...args: Args) => Promise<string | null> | string | null,
    more?: (error: PrismDomainError, playerId: string) => Promise<Record<string, unknown>>,
  ) => async (...args: Args): Promise<Result> => {
    try {
      return await call(...args);
    } catch (error) {
      if (error instanceof PrismDomainError && !NOT_REFUSALS.has(error.code)) {
        const playerId = await Promise.resolve(whose(...args)).catch(() => null);
        const extra = more && playerId ? await more(error, playerId).catch(() => ({})) : {};
        const resourceId = (args[0] as { resourceId?: unknown } | undefined)?.resourceId;
        await publish({
          name: `${action}.refused`,
          playerId,
          ...(typeof resourceId === "string" ? { resourceId } : {}),
          ...(staffOf(args[0]) ? { staffId: staffOf(args[0]) } : {}),
          payload: { code: error.code, message: error.message, ...extra },
        });
      }
      throw error;
    }
  };
  /** Short of money: the bill as it stands goes with a refused checkout, to say how much. */
  const owed = (preview: (playerId: string) => Promise<Parameters<typeof toPlayerCheckoutPreviewView>[0]>) =>
    async (error: PrismDomainError, playerId: string) => {
      if (!error.code.includes("INSUFFICIENT")) return {};
      // What a receipt is worded from; the timeline is the page's, and long.
      const { timeline: _timeline, chargeItems: _items, ...bill } = toPlayerCheckoutPreviewView(await preview(playerId));
      return { bill };
    };
  const checkingOut = <Args extends unknown[], Result>(
    call: (...args: Args) => Promise<Result>,
    whose: (...args: Args) => Promise<string | null> | string | null,
    preview: (playerId: string) => Promise<Parameters<typeof toPlayerCheckoutPreviewView>[0]>,
  ) => attempting("checkout", call, whose, owed(preview));
  const staffOf = (input: unknown) => {
    const staffId = (input as { staffId?: unknown } | undefined)?.staffId;
    return typeof staffId === "string" ? staffId : null;
  };

  const checkouts = (service: PrismAppDependencies["playerCheckoutCommands"]): PrismAppDependencies["playerCheckoutCommands"] => {
    const preview = (playerId: string) => service.previewCheckout({ playerId });
    const whose = (input: { playerId: string }) => input.playerId;
    return {
    ...service,
    checkout: checkingOut(after(service.checkout.bind(service), (result, input) => [settled(result, staffOf(input))]), whose, preview),
    checkoutExternal: checkingOut(after(service.checkoutExternal.bind(service), (result, input) => [settled(result, staffOf(input))]), whose, preview),
    checkoutWithOverride: checkingOut(after(service.checkoutWithOverride.bind(service), (result, input) => [settled(result, staffOf(input))]), whose, preview),
    checkoutWithRecharge: checkingOut(after(service.checkoutWithRecharge.bind(service), (result, input) => [settled(result, staffOf(input))]), whose, preview),
    stopSession: after(service.stopSession.bind(service), (session) => [
      { name: "session.stopped", playerId: session.playerId, payload: { sessionId: session.id } },
    ]),
    };
  };
  const { integrationCommands: integration, staffAssetCommands: assets, playerRedeemCommands: redeem, resourceBilling, staffOperations } = deps;
  const { businessItemOrderCommands: orders, staffPlayerCommands: players } = deps;
  const { staffAssetDefinitionCommands: definitions, staffPricingEffectCommands: effects, staffPricingCommands: pricing } = deps;
  const ordered = (order: { id: string; playerId: string }): ShopFact[] => [
    { name: "order.changed", playerId: order.playerId, payload: { orderId: order.id } },
  ];
  /** The shop's rules changed, as every page shows them and every running bill is priced by them. */
  const shopChanged = (what: string): ShopFact[] => [{ name: "shop.changed", payload: { what } }];

  return {
    ...deps,
    resourceBilling: {
      ...resourceBilling,
      activate: attempting("entry", after(resourceBilling.activate.bind(resourceBilling), (result, input) =>
        // A plan that was already running started nothing.
        result.created === false ? [] : [{
          name: "session.started",
          resourceId: input.resourceId ?? null,
          playerId: input.playerId,
          payload: { sessionId: result.session.id, pricingConfigId: result.session.pricingConfigId ?? null },
        }]), (input) => input.playerId),
    },
    playerCheckoutCommands: checkouts(deps.playerCheckoutCommands),
    staffCheckoutCommands: checkouts(deps.staffCheckoutCommands),
    staffOperations: {
      ...staffOperations,
      checkoutAllActivePlayers: after(staffOperations.checkoutAllActivePlayers.bind(staffOperations), (results) =>
        results.map((result) => settled(result))),
    },
    staffAssetCommands: {
      ...assets,
      adjustWallet: attempting("wallet.adjust", after(assets.adjustWallet.bind(assets), (result, input) => [{
        name: "wallet.adjusted", playerId: input.playerId, staffId: input.staffId,
        payload: { amount: input.amount, reason: input.reason, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter },
      }]), (input) => input.playerId),
      adjustAssets: after(assets.adjustAssets.bind(assets), (_result, input) => [
        { name: "assets.adjusted", playerId: input.playerId, staffId: input.staffId },
      ]),
      grantAssets: after(assets.grantAssets.bind(assets), (_result, input) => [
        { name: "assets.adjusted", playerId: input.playerId, staffId: input.staffId, ...(input.reason ? { payload: { reason: input.reason } } : {}) },
      ]),
    },
    playerRedeemCommands: {
      ...redeem,
      redeemCode: attempting("redeem", after(redeem.redeemCode.bind(redeem), (result, input) => [{
        name: "gift.redeemed", playerId: input.playerId,
        payload: { granted: result.grantedAssets.map((asset) => ({ name: asset.assetName, quantity: asset.quantity })) },
      }]), (input) => input.playerId),
    },
    businessItemOrderCommands: {
      ...orders,
      purchaseBusinessItem: after(orders.purchaseBusinessItem.bind(orders), (result) => ordered(result.order)),
      fulfillBusinessItemOrder: after(orders.fulfillBusinessItemOrder.bind(orders), (order) => ordered(order)),
      cancelBusinessItemOrder: after(orders.cancelBusinessItemOrder.bind(orders), (order) => ordered(order)),
    },
    staffPlayerCommands: {
      ...players,
      createPlayer: after(players.createPlayer.bind(players), (player) => [{ name: "player.changed", playerId: player.id }]),
      updatePlayerStatus: after(players.updatePlayerStatus.bind(players), (player) => [
        { name: "player.changed", playerId: player.id, payload: { status: player.status } },
      ]),
      bindPlayerIdentity: after(players.bindPlayerIdentity.bind(players), (_identity, input) => [{ name: "player.changed", playerId: input.playerId }]),
      deletePlayerIdentity: after(players.deletePlayerIdentity.bind(players), (_nothing, input) => [{ name: "player.changed", playerId: input.playerId }]),
    },
    staffAssetDefinitionCommands: {
      ...definitions,
      saveAssetDefinition: after(definitions.saveAssetDefinition.bind(definitions), (_saved) => shopChanged("assets")),
      archiveAssetDefinition: after(definitions.archiveAssetDefinition.bind(definitions), (_saved) => shopChanged("assets")),
      restoreAssetDefinition: after(definitions.restoreAssetDefinition.bind(definitions), (_saved) => shopChanged("assets")),
    },
    staffPricingEffectCommands: {
      ...effects,
      savePricingEffect: after(effects.savePricingEffect.bind(effects), (_saved) => shopChanged("effects")),
      archivePricingEffect: after(effects.archivePricingEffect.bind(effects), (_saved) => shopChanged("effects")),
      restorePricingEffect: after(effects.restorePricingEffect.bind(effects), (_saved) => shopChanged("effects")),
    },
    staffPricingCommands: {
      ...pricing,
      createPricingConfig: after(pricing.createPricingConfig.bind(pricing), (_saved) => shopChanged("pricing")),
      updatePricingConfig: after(pricing.updatePricingConfig.bind(pricing), (_saved) => shopChanged("pricing")),
      archivePricingConfig: after(pricing.archivePricingConfig.bind(pricing), (_saved) => shopChanged("pricing")),
      restorePricingConfig: after(pricing.restorePricingConfig.bind(pricing), (_saved) => shopChanged("pricing")),
    },
    // Named by a chat identity: the player is whoever that identity is.
    integrationCommands: {
      ...integration,
      confirmCheckoutByIdentity: checkingOut(
        after(integration.confirmCheckoutByIdentity.bind(integration), (result) => [settled(result)]),
        async (input) => (await integration.resolvePlayerByIdentity(input)).id,
        (playerId) => deps.playerCheckoutCommands.previewCheckout({ playerId }),
      ),
      checkoutWithOverrideByIdentity: checkingOut(
        after(integration.checkoutWithOverrideByIdentity.bind(integration), (result) => [settled(result)]),
        async (input) => (await integration.resolvePlayerByIdentity(input)).id,
        (playerId) => deps.playerCheckoutCommands.previewCheckout({ playerId }),
      ),
      stopSessionByIdentity: after(integration.stopSessionByIdentity.bind(integration), (session) => [
        { name: "session.stopped", playerId: session.playerId, payload: { sessionId: session.id } },
      ]),
      adjustWalletByIdentity: attempting("wallet.adjust", after(integration.adjustWalletByIdentity.bind(integration), async (result, input) => [{
        name: "wallet.adjusted", playerId: (await integration.resolvePlayerByIdentity(input)).id,
        payload: { amount: input.amount, reason: input.reason, balanceBefore: result.balanceBefore, balanceAfter: result.balanceAfter },
      }]), async (input) => (await integration.resolvePlayerByIdentity(input)).id),
      adjustAssetsByIdentity: after(integration.adjustAssetsByIdentity.bind(integration), async (_result, input) => [
        { name: "assets.adjusted", playerId: (await integration.resolvePlayerByIdentity(input)).id },
      ]),
      redeemByIdentity: attempting("redeem", after(integration.redeemByIdentity.bind(integration), async (result, input) => [{
        name: "gift.redeemed", playerId: (await integration.resolvePlayerByIdentity(input)).id,
        payload: { granted: result.grantedAssets.map((asset) => ({ name: asset.assetName, quantity: asset.quantity })) },
      }]), async (input) => (await integration.resolvePlayerByIdentity(input)).id),
    },
  };
}
