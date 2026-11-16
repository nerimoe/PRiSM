import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import type { Env, PrismAppDependencies } from "../src/bindings.js";
import { publishShopFacts, withOrigin, type FactOrigin } from "../src/events/shop-facts.js";
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
    return { via, told: new Set(), deferred, defer: (work) => { deferred.push(work); } };
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
    // Whoever else would tell these players' pages and phones knows it was done.
    expect([...bot.told].sort()).toEqual(["p-chat", "p1", "p2"]);
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
    expect(page.told.size).toBe(0);
    await deps.staffOperations.checkoutAllActivePlayers();
    expect(facts().map((row) => [row.name, row.player_id, row.via])).toEqual([
      ["checkout.settled", "p1", "page"], ["checkout.settled", "p2", "page"],
    ]);
    await Promise.all(page.deferred);
    sqlite.close();
  });

  it("never fails what was done when the fact cannot be written, and leaves the player to be told the old way", async () => {
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
    expect(merchant.told.size).toBe(0);
    sqlite.close();
  });
});
