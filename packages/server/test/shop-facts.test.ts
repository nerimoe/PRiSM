import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import type { Env, PrismAppDependencies } from "../src/bindings.js";
import { publishShopFacts, withOrigin, type FactOrigin } from "../src/events/shop-facts.js";
import { announcementSubscriber, billingSubscriber, idleTimerSubscriber, shopChangedSubscriber } from "../src/events/subscribers.js";
import type { Heard } from "../src/events/dispatcher.js";
import type { DeviceEvent } from "@prism/core";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";

const migrations = resolve(import.meta.dir, "../../../migrations");

function fixture() {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(migrations).filter((s) => s.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=OFF");
  const db = createD1DatabaseFromSqlite(sqlite);
  const runtime = { db, env: { DB: db } as unknown as Env, shopId: "shop" };
  const origin = (via: FactOrigin["via"]): FactOrigin & { deferred: Promise<unknown>[] } => {
    const deferred: Promise<unknown>[] = [];
    return { via, deferred, defer: (work) => { deferred.push(work); } };
  };
  const facts = () => sqlite.query(
    "SELECT device_id, capability, kind, name, origin, player_id, staff_id, via, via_resource_id, payload_json FROM device_events ORDER BY rowid",
  ).all() as Array<Record<string, string | null>>;
  return { sqlite, runtime, origin, facts };
}

/** The services a caller reaches, answering as the real ones do. */
function services(calls: string[]) {
  const settlement = (playerId: string) => ({
    playerSettlement: { playerId, sessionIds: ["s1", "s2"], subtotal: 3000, total: 2500, status: "settled", settledAt: new Date() },
    settlements: [], sessionDetails: [],
  });
  const checkout = {
    async checkout(input: { playerId: string }) { calls.push("checkout"); return settlement(input.playerId); },
    async checkoutExternal(input: { playerId: string }) { return settlement(input.playerId); },
    async checkoutWithOverride(input: { playerId: string }) { return settlement(input.playerId); },
    async checkoutWithRecharge(input: { playerId: string }) { return settlement(input.playerId); },
    async stopSession(input: { playerId: string; sessionId: string }) { return { id: input.sessionId, playerId: input.playerId }; },
    async previewCheckout() { calls.push("preview"); return { preview: true }; },
  };
  return {
    repositories: { marker: "shared" },
    resourceBilling: {
      async activate(input: { resourceId?: string; playerId: string }) {
        calls.push("activate");
        return { created: input.playerId !== "already-in", session: { id: "s1", pricingConfigId: "plan" } };
      },
      async planOf() { return "plan"; },
    },
    playerCheckoutCommands: checkout,
    staffCheckoutCommands: checkout,
    staffOperations: { async checkoutAllActivePlayers() { return [settlement("p1"), settlement("p2")]; }, async listLivePlayers() { return []; } },
    staffAssetCommands: {
      async adjustWallet() { return { balanceBefore: 1000, balanceAfter: 1500 }; },
      async adjustAssets() { return {}; },
      async grantAssets() { return {}; },
    },
    playerRedeemCommands: { async redeemCode() { return { grantedAssets: [{ assetName: "券", quantity: 2, assetCode: "t", assetType: "ticket" }] }; } },
    businessItemOrderCommands: {
      async purchaseBusinessItem(input: { playerId: string }) { return { order: { id: "o1", playerId: input.playerId }, assetLedgerEntries: [] }; },
      async fulfillBusinessItemOrder(input: { orderId: string }) { return { id: input.orderId, playerId: "p3" }; },
      async cancelBusinessItemOrder(input: { orderId: string }) { return { id: input.orderId, playerId: "p3" }; },
      async listBusinessItemOrders() { calls.push("orders"); return []; },
    },
    staffPlayerCommands: {
      async createPlayer() { return { id: "p-new", status: "active" }; },
      async updatePlayerStatus(input: { playerId: string; status: string }) { return { id: input.playerId, status: input.status }; },
      async bindPlayerIdentity() { return {}; },
      async deletePlayerIdentity() {},
      async resolvePlayerIdentity() { return null; },
    },
    staffAssetDefinitionCommands: {
      async saveAssetDefinition() { return {}; }, async archiveAssetDefinition() { return {}; },
      async restoreAssetDefinition() { return {}; }, async listAssetDefinitions() { calls.push("definitions"); return []; },
    },
    staffPricingEffectCommands: {
      async savePricingEffect() { return {}; }, async archivePricingEffect() { return {}; },
      async restorePricingEffect() { return {}; }, async listPricingEffects() { return []; },
    },
    staffPricingCommands: {
      async createPricingConfig() { return {}; }, async updatePricingConfig() { return {}; },
      async archivePricingConfig() { return {}; }, async restorePricingConfig() { return {}; },
      async listPricingConfigs() { calls.push("plans"); return []; },
    },
    integrationCommands: {
      async resolvePlayerByIdentity() { return { id: "p-chat" }; },
      async confirmCheckoutByIdentity() { return settlement("p-chat"); },
      async checkoutWithOverrideByIdentity() { return settlement("p-chat"); },
      async stopSessionByIdentity() { return { id: "s9", playerId: "p-chat" }; },
      async adjustWalletByIdentity() { return { balanceBefore: 0, balanceAfter: 500 }; },
      async adjustAssetsByIdentity() { return {}; },
      async redeemByIdentity() { return { grantedAssets: [] }; },
    },
  } as unknown as PrismAppDependencies;
}

describe("shop facts", () => {
  it("publishes what a service did from where its caller stands, and answers as before", async () => {
    const { sqlite, runtime, origin, facts } = fixture();
    const calls: string[] = [];
    const base = services(calls);
    const bot = origin({ channel: "bot", resourceId: "bot-1" });
    const deps = withOrigin(base, runtime, bot);

    // Everything that does not move a bill is the shared instance.
    expect(deps.repositories).toBe(base.repositories);
    expect(await deps.resourceBilling.activate({ resourceId: "bot-1", playerId: "p1" } as never))
      .toEqual({ created: true, session: { id: "s1", pricingConfigId: "plan" } } as never);
    expect((await deps.playerCheckoutCommands.checkout({ playerId: "p1" })).playerSettlement.total).toBe(2500 as never);
    await deps.staffAssetCommands.adjustWallet({ staffId: "st1", playerId: "p2", amount: 5, reason: "补偿" });
    await deps.integrationCommands.redeemByIdentity({ identity: { provider: "onebot", subject: "1" }, code: "GIFT" } as never);
    // Reading is not a fact.
    await deps.playerCheckoutCommands.previewCheckout({ playerId: "p1" });
    expect(calls).toEqual(["activate", "checkout", "preview"]);

    expect(facts().map(({ payload_json, ...row }) => [row, JSON.parse(payload_json!)])).toEqual([
      [{ device_id: "bot-1", capability: "shop", kind: "signal", name: "session.started", origin: "platform", player_id: "p1", staff_id: null, via: "bot", via_resource_id: "bot-1" },
        { sessionId: "s1", pricingConfigId: "plan" }],
      [{ device_id: null, capability: "shop", kind: "signal", name: "checkout.settled", origin: "platform", player_id: "p1", staff_id: null, via: "bot", via_resource_id: "bot-1" },
        { sessionIds: ["s1", "s2"], subtotal: 3000, total: 2500 }],
      [{ device_id: null, capability: "shop", kind: "signal", name: "wallet.adjusted", origin: "platform", player_id: "p2", staff_id: "st1", via: "bot", via_resource_id: "bot-1" },
        { amount: 5, reason: "补偿", balanceBefore: 1000, balanceAfter: 1500 }],
      [{ device_id: null, capability: "shop", kind: "signal", name: "gift.redeemed", origin: "platform", player_id: "p-chat", staff_id: null, via: "bot", via_resource_id: "bot-1" },
        { granted: [] }],
    ]);
    // Telling them is left for after the answer.
    expect(bot.deferred).toHaveLength(4);
    await Promise.all(bot.deferred);
    sqlite.close();
  });

  it("says nothing when nothing happened, and one fact per player a sweep checked out", async () => {
    const { sqlite, runtime, origin, facts } = fixture();
    const page = origin({ channel: "page", resourceId: null });
    const deps = withOrigin(services([]), runtime, page);
    // The plan was already running: no visit started.
    await deps.resourceBilling.activate({ resourceId: "door", playerId: "already-in" } as never);
    expect(facts()).toEqual([]);
    await deps.staffOperations.checkoutAllActivePlayers();
    expect(facts().map((row) => [row.name, row.player_id, row.via])).toEqual([
      ["checkout.settled", "p1", "page"], ["checkout.settled", "p2", "page"],
    ]);
    await Promise.all(page.deferred);
    sqlite.close();
  });

  it("says an order, a player's standing and the shop's own rules changed, and nothing for a read", async () => {
    const { sqlite, runtime, origin, facts } = fixture();
    const calls: string[] = [];
    const merchant = origin({ channel: "merchant", resourceId: null });
    const deps = withOrigin(services(calls), runtime, merchant);
    await deps.businessItemOrderCommands.purchaseBusinessItem({ playerId: "p1", businessItemId: "b1" } as never);
    await deps.businessItemOrderCommands.cancelBusinessItemOrder({ orderId: "o2" });
    await deps.staffPlayerCommands.updatePlayerStatus({ playerId: "p4", status: "disabled" } as never);
    await deps.staffPlayerCommands.deletePlayerIdentity({ playerId: "p4", provider: "onebot", subject: "1" } as never);
    await deps.staffPricingCommands.archivePricingConfig({ pricingConfigId: "plan" });
    await deps.staffAssetDefinitionCommands.saveAssetDefinition({} as never);
    await deps.businessItemOrderCommands.listBusinessItemOrders();
    await deps.staffPricingCommands.listPricingConfigs();
    await deps.staffAssetDefinitionCommands.listAssetDefinitions();
    expect(calls).toEqual(["orders", "plans", "definitions"]);
    expect(facts().map((row) => [row.name, row.player_id, row.via, JSON.parse(row.payload_json!)])).toEqual([
      ["order.changed", "p1", "merchant", { orderId: "o1" }],
      ["order.changed", "p3", "merchant", { orderId: "o2" }],
      ["player.changed", "p4", "merchant", { status: "disabled" }],
      ["player.changed", "p4", "merchant", {}],
      // The shop's rules are nobody's in particular.
      ["shop.changed", null, "merchant", { what: "pricing" }],
      ["shop.changed", null, "merchant", { what: "assets" }],
    ]);
    await Promise.all(merchant.deferred);
    sqlite.close();
  });

  it("never fails what was done when the fact cannot be written", async () => {
    const { sqlite, runtime, origin } = fixture();
    sqlite.run("DROP TABLE device_events");
    const merchant = origin({ channel: "merchant", resourceId: null });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await publishShopFacts(runtime, merchant, [{ name: "wallet.adjusted", playerId: "p1" }]);
      expect((await withOrigin(services([]), runtime, merchant).playerCheckoutCommands.checkout({ playerId: "p1" })).playerSettlement.playerId)
        .toBe("p1");
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(2);
    sqlite.close();
  });

  it("is told to the shop's bots under its own name, saying where it came from and what it was about", async () => {
    const { sqlite, runtime } = fixture();
    sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','A',0,0,80,'u')");
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','m1','pub-m1','舞萌','')");
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','小明','active','2026-01-01')");
    const told: Array<Record<string, any>> = [];
    const env = { DB: runtime.db, SHOP_HUB: { getByName: () => ({ async shopEvent(event: Record<string, any>) { told.push(event); } }) } } as unknown as Env;
    let seq = 0;
    const heard = (name: string, extra: Partial<DeviceEvent>): Heard => ({
      type: name,
      event: {
        id: `e${++seq}`, deviceId: null, capability: "shop", kind: "signal", name, operationId: null, parentOperationId: null,
        origin: "platform", playerId: "p1", staffId: null, payload: {}, occurredAt: new Date(), via: { channel: "page", resourceId: null }, ...extra,
      },
    });
    await announcementSubscriber.run({ db: runtime.db, env, shopId: "shop" }, [
      heard("session.started", { deviceId: "m1", payload: { sessionId: "s1" } }),
      heard("checkout.settled", { payload: { sessionIds: ["s1"], subtotal: 3000, total: 2500 } }),
      heard("wallet.adjusted", { payload: { amount: -5 }, via: { channel: "bot", resourceId: "bot-1" } }),
      heard("coin.refused", { deviceId: "m1", capability: "hinata_io", payload: { code: "COIN_CABINET_FULL", message: "达到机台投币上限" } }),
      heard("power.on.refused", { deviceId: "m1", capability: "power", playerId: null, payload: { code: "SOMETHING_NEW", message: "请先开机" } }),
    ]);
    const words = (event: Record<string, any>) =>
      (event.message as Array<{ text?: string; player?: { displayName: string } }>).map((part) => part.text ?? `<${part.player?.displayName}>`).join("");
    expect(told.map((event) => [event.type, event.via, event.resourceName, event.botId ?? null, words(event)])).toEqual([
      ["session.started", "page", "舞萌", null, "🚪 <小明> 入场"],
      ["checkout.settled", "page", "", null, "🧾 <小明> 结账 25"],
      // Through a bot: that bot answered it already and is not told again.
      ["wallet.adjusted", "bot", "", "bot-1", "💰 <小明> 余额调整 -5"],
      ["request.refused", "page", "舞萌", null, "⛔ <小明> 投币被拒绝：达到机台投币上限"],
      // A reason the platform has no word for is told in the refusal's own.
      ["request.refused", "page", "舞萌", null, "⛔ 店员 开机被拒绝：请先开机"],
    ]);
    sqlite.close();
  });

  it("tells a player's pages and the idle timers from what happened, with nobody reading a response for it", async () => {
    const { sqlite, runtime } = fixture();
    const hub = { pages: [] as Array<[unknown, string]>, idle: [] as unknown[] };
    const env = { DB: runtime.db, SHOP_HUB: { getByName: () => ({
      async pagesChanged(scope: unknown, reason: string) { hub.pages.push([scope, reason]); },
      async idleEvents(_shopId: string, signals: unknown[]) { hub.idle.push(...signals); },
    }) } } as unknown as Env;
    const context = { db: runtime.db, env, shopId: "shop" };
    let seq = 0;
    const heard = (name: string, extra: Partial<DeviceEvent> = {}): Heard => {
      const event: DeviceEvent = {
        id: `e${++seq}`, deviceId: null, capability: "shop", kind: "signal", name, operationId: null, parentOperationId: null,
        origin: "platform", playerId: "p1", staffId: null, payload: {}, occurredAt: new Date(), via: { channel: "page", resourceId: null }, ...extra,
      };
      return { event, type: event.kind === "result" ? `${name}.sent` : name };
    };
    const coin = heard("coin", { kind: "result", capability: "hinata_io", deviceId: "m1", playerId: null, payload: { outcome: "ok", forPlayerId: "p2" } });

    // A bill or balance moved, an order changed, and a request made for a player was taken by the hardware.
    await billingSubscriber.run(context, [heard("checkout.settled", { payload: { sessionIds: ["s1"] } }), heard("order.changed", { playerId: "p3" }), coin]);
    expect(hub.pages).toEqual([[{ player: "p1" }, "billing"], [{ player: "p3" }, "billing"], [{ player: "p2" }, "billing"]]);

    // The shop's rules changed: every page shows them.
    hub.pages.length = 0;
    await shopChangedSubscriber.run(context, [heard("shop.changed", { playerId: null })]);
    expect(hub.pages).toEqual([[{ shop: true }, "shop"]]);

    // The idle timers hear only what moves them. A balance does not.
    await idleTimerSubscriber.run(context, [heard("wallet.adjusted")]);
    expect(hub.idle).toEqual([]);
    // A bill closing, once however many closed; a coin the hardware took; a device switched on and off.
    const result = (name: string) => heard(name, { kind: "result", capability: "power", deviceId: "m1", playerId: null, payload: { outcome: "ok" } });
    await idleTimerSubscriber.run(context, [heard("checkout.settled"), heard("session.stopped"), coin, result("power.on"), result("power.off"), result("power.keep")]);
    expect(hub.idle).toEqual([
      { kind: "sessions" },
      { kind: "activity", deviceId: "m1" },
      { kind: "on", deviceId: "m1" },
      { kind: "off", deviceId: "m1" },
    ]);
    // An authorised card is the stay it begins; a cabinet's own count of a coin is a coin; a card nobody is billed for is nothing.
    hub.idle.length = 0;
    const reported = (name: string, capability = "hinata_io") => heard(name, { capability, deviceId: "m2", origin: "device", playerId: null });
    await idleTimerSubscriber.run(context, [reported("occupancy.seen", "occupancy"), reported("cabinet.coin"), reported("card.consumed")]);
    expect(hub.idle).toEqual([{ kind: "activity", deviceId: "m2", stay: true }, { kind: "activity", deviceId: "m2" }]);
    // What the hub did itself is not told back to it.
    hub.idle.length = 0;
    await idleTimerSubscriber.run({ ...context, insideHub: true }, [coin]);
    expect(hub.idle).toEqual([]);
    sqlite.close();
  });
});
