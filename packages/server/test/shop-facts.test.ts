import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import type { Env, PrismAppDependencies } from "../src/bindings.js";
import { publishShopFacts, withOrigin, type FactOrigin } from "../src/events/shop-facts.js";
import { announcementSubscriber, billingSubscriber, idleTimerSubscriber, shopChangedSubscriber } from "../src/events/subscribers.js";
import type { Heard } from "../src/events/dispatcher.js";
import { PrismDomainError, type DeviceEvent } from "@prism/core";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { announcementMessage, type ShopEvent } from "../src/resources/shop-events.js";

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
    // Both facts were lost, and said so; neither call failed.
    expect(errors.filter((error) => String(error).includes("shop_fact_publish_failed"))).toHaveLength(2);
    sqlite.close();
  });

  it("says a checkout the shop's rules turned away, with the bill as it stands when the balance fell short", async () => {
    const { sqlite, runtime, origin, facts } = fixture();
    const calls: string[] = [];
    const base = services(calls);
    let refusal = new PrismDomainError("Insufficient currency holdings for this operation.", "INSUFFICIENT_BALANCE");
    const failing = {
      ...base.playerCheckoutCommands,
      async checkout() { throw refusal; },
      async previewCheckout() {
        calls.push("preview");
        const at = new Date("2026-11-20T07:00:00.000Z");
        return {
          settlementPreview: { playerId: "p1", sessionIds: ["s1"], subtotal: 3000, total: 3000, previewedAt: at },
          sessionPreviews: [{
            sessionId: "s1", label: "畅玩", startedAt: new Date("2026-11-20T06:00:00.000Z"), endedAt: null, status: "active",
            subtotal: 3000, total: 3000, chargeItems: [], adjustments: [],
          }],
          chargeItems: [], adjustments: [], checkoutAdjustments: [], pricingCapAdjustments: [], globalCapWindows: [],
          wallet: { balanceBefore: 2500, balanceAfter: -500 },
        } as never;
      },
    };
    const deps = withOrigin({ ...base, playerCheckoutCommands: failing } as unknown as PrismAppDependencies, runtime, origin({ channel: "page", resourceId: null }));
    // The caller hears the same error; the refusal is a fact of its own.
    await expect(deps.playerCheckoutCommands.checkout({ playerId: "p1" } as never)).rejects.toBe(refusal);
    const [refused] = facts();
    expect(refused).toMatchObject({ capability: "shop", kind: "signal", name: "checkout.refused", player_id: "p1", via: "page" });
    const payload = JSON.parse(refused!.payload_json!);
    expect(payload).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    // Short of money: the bill as it stands goes with it, to say how much.
    expect(calls).toEqual(["preview"]);
    expect(payload.bill).toMatchObject({ settlementPreview: { total: 30 }, wallet: { balanceBefore: 25, balanceAfter: -5 } });
    expect(payload.bill.timeline).toBeUndefined();
    // Nothing to pay is not news, and a fault is not a refusal.
    refusal = new PrismDomainError("Player has no sessions to settle.", "PLAYER_HAS_NO_UNSETTLED_SESSIONS");
    await expect(deps.playerCheckoutCommands.checkout({ playerId: "p1" } as never)).rejects.toBe(refusal);
    refusal = new Error("D1 went away") as never;
    await expect(deps.playerCheckoutCommands.checkout({ playerId: "p1" } as never)).rejects.toBe(refusal);
    expect(facts()).toHaveLength(1);
    // Another reason is said without a bill.
    refusal = new PrismDomainError("请在前台确认现场收款", "CASHIER_PAYMENT_REQUIRED");
    await expect(deps.playerCheckoutCommands.checkout({ playerId: "p1" } as never)).rejects.toBe(refusal);
    expect(JSON.parse(facts()[1]!.payload_json!)).toEqual({ code: "CASHIER_PAYMENT_REQUIRED", message: "请在前台确认现场收款" });
    expect(calls).toEqual(["preview"]);
    sqlite.close();
  });

  it("tells a card bound without its number, and where a coin or a card came from", async () => {
    const { sqlite, runtime } = fixture();
    sqlite.run("INSERT INTO machines(shop_id,id,public_id,name,hinata_url_encrypted) VALUES ('shop','m1','pub-m1','舞萌','')");
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','小明','active','2026-01-01')");
    const told: Array<Record<string, any>> = [];
    const env = { DB: runtime.db, SHOP_HUB: { getByName: () => ({ async shopEvent(event: Record<string, any>) { told.push(event); } }) } } as unknown as Env;
    let seq = 0;
    const heard = (type: string, extra: Partial<DeviceEvent>): Heard => ({
      type,
      event: {
        id: `c${++seq}`, deviceId: "m1", capability: "hinata_io", kind: "signal", name: type, operationId: null, parentOperationId: null,
        origin: "platform", playerId: "p1", staffId: null, payload: {}, occurredAt: new Date(), via: { channel: "page", resourceId: null }, ...extra,
      },
    });
    await announcementSubscriber.run({ db: runtime.db, env, shopId: "shop" }, [
      heard("card.bound", { capability: "shop", payload: { type: "aime" } }),
      heard("coin.sent", { kind: "result", name: "coin", payload: { outcome: "ok", cause: "card" }, via: { channel: "system", resourceId: null } }),
      heard("coin.sent", { kind: "result", name: "coin", payload: { outcome: "ok" } }),
      heard("card.consumed", { origin: "device", payload: { cardFrom: "reader" }, via: { channel: "relay", resourceId: null } }),
      // Recorded before it said so: a card the platform sent belongs to an operation.
      heard("card.consumed", { origin: "device", operationId: "op", payload: {}, via: { channel: "relay", resourceId: null } }),
    ]);
    const words = (event: Record<string, any>) =>
      (event.message as Array<{ text?: string; player?: { displayName: string } }>).map((part) => part.text ?? `<${part.player?.displayName}>`).join("");
    expect(told.map(words)).toEqual([
      "💳 <小明> 添加了一张 Aime 卡",
      "🪙 <小明> 在 舞萌 自动投币",
      "🪙 <小明> 在 舞萌 投币",
      "💳 <小明> 在 舞萌 刷卡",
      "💳 <小明> 在 舞萌 虚拟刷卡",
    ]);
    // A shop's own words from before the source was said still apply.
    expect(words({ message: announcementMessage(told[1] as ShopEvent, { "announce.request.coin.message": "{player} 在 {device} 投了币" }, told[1]!.message) }))
      .toBe("<小明> 在 舞萌 投了币");
    sqlite.close();
  });

  it("tells a refused checkout why, and the bill as it stands when there is one", async () => {
    const { sqlite, runtime } = fixture();
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','小明','active','2026-01-01')");
    const told: Array<Record<string, any>> = [];
    const env = { DB: runtime.db, SHOP_HUB: { getByName: () => ({ async shopEvent(event: Record<string, any>) { told.push(event); } }) } } as unknown as Env;
    const refused = (payload: Record<string, unknown>): Heard => ({
      type: "checkout.refused",
      event: {
        id: `r${told.length}`, deviceId: null, capability: "shop", kind: "signal", name: "checkout.refused", operationId: null, parentOperationId: null,
        origin: "platform", playerId: "p1", staffId: null, occurredAt: new Date(), via: { channel: "bot", resourceId: "bot-1" }, payload,
      },
    });
    const words = (message: unknown) => (message as Array<{ text?: string; player?: { displayName: string } }>)
      .map((part) => part.text ?? `<${part.player?.displayName}>`).join("");
    await announcementSubscriber.run({ db: runtime.db, env, shopId: "shop" }, [refused({ code: "CASHIER_PAYMENT_REQUIRED", message: "请在前台确认现场收款" })]);
    // The words the player is told, as the platform has them.
    expect(told[0]).toMatchObject({ type: "checkout.refused", botId: "bot-1", detail: { reason: "请在前台确认现场收款" } });
    expect(words(told[0]!.message)).toBe("⛔ <小明> 结账失败：请在前台确认现场收款");
    const bill = {
      settlementPreview: { playerId: "p1", subtotal: 30, total: 30, previewedAt: "2026-11-20T07:00:00.000Z" },
      sessionPreviews: [{ label: "畅玩", startedAt: "2026-11-20T06:00:00.000Z", endedAt: null, status: "active", total: 30, adjustments: [] }],
      checkoutAdjustments: [], pricingCapAdjustments: [], globalCapWindows: [],
      wallet: { balanceBefore: 25, balanceAfter: -5 },
    };
    await announcementSubscriber.run({ db: runtime.db, env, shopId: "shop" }, [refused({ code: "INSUFFICIENT_BALANCE", message: "x", bill })]);
    const said = words(told[1]!.message);
    expect(said.startsWith("⛔ 结账失败：余额不足\n玩家：<小明>\n")).toBe(true);
    expect(said).toContain("还差 5");
    sqlite.close();
  });

  it("tells a checkout as its bill, which a shop's own words may place with {bill}", async () => {
    const { sqlite, runtime } = fixture();
    sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','A',0,0,80,'u')");
    sqlite.run(`INSERT INTO app_settings(shop_id,key,value_json,updated_at) VALUES ('shop','store.profile','{"timeZone":"Asia/Shanghai"}','2026-01-01')`);
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','小明','active','2026-01-01')");
    const told: Array<Record<string, any>> = [];
    const env = { DB: runtime.db, SHOP_HUB: { getByName: () => ({ async shopEvent(event: Record<string, any>) { told.push(event); } }) } } as unknown as Env;
    const bill = {
      settlementPreview: { playerId: "p1", subtotal: 30, total: 25 },
      sessionPreviews: [{ label: "畅玩", startedAt: "2026-11-20T06:00:00.000Z", endedAt: "2026-11-20T07:30:00.000Z", status: "closed", total: 30, adjustments: [] }],
      checkoutAdjustments: [{ id: "d", label: "会员折扣", amount: -5 }],
      pricingCapAdjustments: [], globalCapWindows: [],
      wallet: { balanceBefore: 100, balanceAfter: 75 },
    };
    await announcementSubscriber.run({ db: runtime.db, env, shopId: "shop" }, [{
      type: "checkout.settled",
      event: {
        id: "e1", deviceId: null, capability: "shop", kind: "signal", name: "checkout.settled", operationId: null, parentOperationId: null,
        origin: "platform", playerId: "p1", staffId: null, occurredAt: new Date(), via: { channel: "page", resourceId: null },
        payload: { sessionIds: ["s1"], subtotal: 3000, total: 2500, bill },
      },
    }]);
    const words = (message: unknown) => (message as Array<{ text?: string; player?: { displayName: string } }>)
      .map((part) => part.text ?? `<${part.player?.displayName}>`).join("");
    const said = words(told[0]!.message);
    expect(said.startsWith("🧾 结算账单\n玩家：<小明>\n")).toBe(true);
    for (const line of ["畅玩", "游玩时段：14:00-15:30", "会员折扣", "75"]) expect(said).toContain(line);
    // The hub renders each bot's own words over it.
    const rendered = (templates: Record<string, string>) =>
      words(announcementMessage({ ...told[0], message: told[0]!.bill } as ShopEvent, templates, told[0]!.message));
    expect(rendered({})).toBe(said);
    expect(rendered({ "announce.checkout.settled.message": "{player} 付了 {amount}" })).toBe("<小明> 付了 25");
    expect(rendered({ "announce.checkout.settled.message": "收银台：\n{bill}" })).toBe(`收银台：\n${said}`);
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
      { kind: "keep", deviceId: "m1" },
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
