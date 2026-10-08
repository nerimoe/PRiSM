import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createBunSqliteExecutor } from "@prism/adapter-sqlite";
import {
  createLiveBillingCalculator,
  hydrateLiveBillingSnapshot,
} from "@prism/application";
import { centsOf, type PricingConfig } from "@prism/core";
import { createSqlRepositories, sqliteSchema } from "@prism/storage-sql";
import { createPrismRuntimeDependencies, createRuntimeQueries } from "../src";
import { createPrismApp } from "./test-app";

function fixture(at = "2026-09-07T10:00:00Z") {
  const db = new Database(":memory:");
  for (const sql of sqliteSchema) db.run(sql);
  let clock = new Date(at);
  const now = () => clock,
    id = () => crypto.randomUUID();
  const reads: string[] = [];
  const base = createBunSqliteExecutor(db, "shop");
  const executor: typeof base = {
    ...base,
    async all(sql, params) {
      reads.push(sql);
      return base.all(sql, params);
    },
    async first(sql, params) {
      reads.push(sql);
      return base.first(sql, params);
    },
  };
  const repositories = createSqlRepositories({ executor, now, id });
  const deps = createPrismRuntimeDependencies({
    repositories,
    queries: createRuntimeQueries({ executor, now }),
    now,
    id,
    pricingProviders: [],
    assetEffectProviders: [],
    coinCooldownMs: 0,
  });
  const rate: PricingConfig & { kind: "time.priority" } = {
    id: "rate",
    kind: "time.priority",
    name: "Original",
    enabled: true,
    createdAt: clock,
    updatedAt: clock,
    provider: {
      id: "provider",
      timeZone: "UTC",
      rules: [
        {
          id: "day",
          label: "Day",
          priority: 1,
          timeRange: { start: "02:00", end: "19:00" },
          pricing: {
            unitMinutes: 60,
            unitPrice: 18,
            roundGraceMinutes: 10,
            priceCap: 90,
          },
        },
      ],
    },
  };
  async function player(playerId: string) {
    await repositories.players.save({
      id: playerId,
      displayName: playerId,
      status: "active",
      createdAt: clock,
    });
    return deps.playerCommands.startSession({
      playerId,
      pricingConfigIds: ["rate"],
      label: "entry",
    });
  }
  return {
    db,
    deps,
    repositories,
    reads,
    rate,
    player,
    clock: (at: string) => {
      clock = new Date(at);
    },
  };
}

test("15 month-long visits load a shared read-only snapshot without running server quotes", async () => {
  const f = fixture();
  try {
    await f.repositories.system.setAppSetting("store.profile", {
      timeZone: "Asia/Shanghai",
    });
    await f.repositories.pricingConfigs.save(f.rate);
    for (let i = 0; i < 15; i++) await f.player(`p${i}`);
    f.clock("2026-10-07T10:00:00Z");
    const changes = f.db.query("SELECT total_changes() AS n").get();
    let quotes = 0;
    const preview = f.deps.playerCheckoutCommands!.previewCheckout;
    f.deps.playerCheckoutCommands!.previewCheckout = async (input) => {
      quotes++;
      return preview(input);
    };
    f.reads.length = 0;
    const response = await createPrismApp(f.deps).request(
      "/rpc/staff/live-players",
      { headers: { Authorization: "Bearer staff-token" } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      players: Awaited<
        ReturnType<typeof f.deps.staffOperations.listLivePlayers>
      >;
      billingSnapshot: unknown;
    };
    expect(quotes).toBe(0);
    expect(f.db.query("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(body.players).toHaveLength(15);
    expect(
      body.players.every(
        (player) => player.estimatedTotal === null && !player.timeline,
      ),
    ).toBe(true);
    expect(body.players[0]!.sessions[0]!.startedAt).toBe(
      "2026-09-07T18:00:00.000+08:00",
    );
    const snapshot = hydrateLiveBillingSnapshot(body.billingSnapshot);
    expect(snapshot.capturedAt.toISOString()).toBe("2026-10-07T10:00:00.000Z");
    expect(snapshot.pricingReleases).toHaveLength(1);
    expect(snapshot.players[0]!.sessions[0]!.startedAt.toISOString()).toBe(
      "2026-09-07T10:00:00.000Z",
    );
    // Basic list, display settings, seven bulk inputs and one shared release; no per-player queries.
    expect(f.reads.length).toBeLessThanOrEqual(14);
    expect(JSON.stringify(body).length).toBeLessThan(25_000);
    const client = createLiveBillingCalculator(snapshot, body.players);
    const backend = await f.deps.staffOperations.listLivePlayers();
    for (const row of backend) {
      expect(JSON.stringify(await client.calculatePlayer(row.playerId))).toBe(
        JSON.stringify(row),
      );
      expect(row.estimatedTotal).toBe(2790);
    }
  } finally {
    f.db.close();
  }
});

test("browser previews retain pinned versions, paid cap history, stopped sessions and optional discounts", async () => {
  const f = fixture("2026-10-07T02:00:00Z");
  try {
    await f.repositories.pricingConfigs.save(f.rate);
    await f.repositories.pricingConfigs.save({
      id: "cap",
      name: "Cap",
      kind: "time.cap",
      enabled: true,
      createdAt: new Date("2026-10-07T02:00:00Z"),
      updatedAt: new Date("2026-10-07T02:00:00Z"),
      provider: {
        id: "cap-provider",
        timeZone: "UTC",
        includedPricingConfigIds: ["rate"],
        rules: [
          {
            id: "day",
            label: "Day",
            priority: 1,
            timeRange: { start: "02:00", end: "19:00" },
            priceCap: 50,
          },
        ],
      },
    });
    await f.repositories.assetDefinitions.save({
      type: "currency",
      code: "paid",
      name: "Paid",
      stackable: true,
      metadata: null,
    });
    await f.repositories.pricingEffects.save({
      id: "discount-effect",
      name: "Discount",
      type: "discount",
      scope: "session",
      value: 3,
      limitPerDay: 1,
      consumable: false,
      activeAt: new Date("2026-10-01T00:00:00Z"),
      expiresAt: new Date("2026-11-01T00:00:00Z"),
      config: { daysOfWeek: [3] },
    });
    await f.repositories.assetDefinitions.save({
      type: "coupon",
      code: "discount",
      name: "Discount",
      stackable: true,
      pricingEffectId: "discount-effect",
      metadata: null,
    });
    for (const name of ["discounted", "used", "cashier"]) {
      await f.player(name);
      if (name === "cashier")
        f.db.run(
          "INSERT INTO cashier_profiles(shop_id,player_id,card_kind,card_uid,created_at) VALUES('shop',?,'type-a','ABCD','2026-10-07T02:00:00.000Z')",
          [name],
        );
      else {
        f.db.run(
          "INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES('shop',?,?,'currency','paid',100000)",
          [`${name}-money`, name],
        );
        f.db.run(
          "INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity,active_at,expires_at) VALUES('shop',?,?,'coupon','discount',1,'2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')",
          [`${name}-coupon`, name],
        );
      }
    }
    // Paid visit in the same daily cap window, with a prior daily discount use.
    f.db.run(
      "INSERT INTO sessions(shop_id,id,player_id,started_at,ended_at,status,payment_status) VALUES('shop','paid','used','2026-10-07T02:00:00.000Z','2026-10-07T02:30:00.000Z','closed','paid')",
    );
    f.db.run(
      "INSERT INTO settlements(shop_id,id,session_id,subtotal,total,status,settled_at) VALUES('shop','paid-settlement','paid',1000,700,'settled','2026-10-07T02:30:00.000Z')",
    );
    f.db.run(
      "INSERT INTO settlement_adjustments(shop_id,id,session_id,adjustment_order,source,label,amount) VALUES('shop','prior-discount','paid',0,'coupon.discount','Discount',-300)",
    );
    f.db.run(
      "INSERT INTO pricing_history_entries(shop_id,id,player_id,pricing_config_id,provider_id,rule_id,rule_anchor_at,session_id,amount,created_at) VALUES('shop','history','used','rate','provider','day','2026-10-07T02:00:00.000Z','paid',1800,'2026-10-07T02:30:00.000Z')",
    );
    f.db.run(
      "INSERT INTO pricing_cap_history_entries(shop_id,id,player_id,cap_config_id,cap_rule_id,cap_anchor_at,included_pricing_config_ids_json,session_ids_json,amount,created_at) VALUES('shop','cap-history','used','cap','day','2026-10-07T02:00:00.000Z','[\"rate\"]','[\"paid\"]',1800,'2026-10-07T02:30:00.000Z')",
    );
    f.clock("2026-10-07T05:00:00Z");
    const stopped = (
      await f.repositories.sessions.findActiveByPlayerId("discounted")
    )[0]!;
    await f.repositories.sessions.save({
      ...stopped,
      status: "closed",
      endedAt: new Date("2026-10-07T05:00:00Z"),
    });
    await f.repositories.pricingConfigs.save({
      ...f.rate,
      name: "Changed",
      enabled: false,
      status: "archived",
      provider: {
        ...f.rate.provider,
        rules: f.rate.provider.rules.map((rule) => ({
          ...rule,
          pricing: { ...rule.pricing, unitPrice: 999 },
        })),
      },
    });
    f.clock("2026-10-07T06:00:00Z");
    const base = await f.deps.staffOperations.listLivePlayers({
      summary: true,
    });
    const snapshot = hydrateLiveBillingSnapshot(
      JSON.parse(
        JSON.stringify(
          await f.deps.staffLiveBillingSnapshot!(
            base.map((row) => row.playerId),
          ),
        ),
      ),
    );
    expect(
      snapshot.players.find((player) => player.playerId === "used")!
        .pastAppliedAdjustments,
    ).toHaveLength(1);
    const client = createLiveBillingCalculator(snapshot, base);
    for (const row of await f.deps.staffOperations.listLivePlayers()) {
      expect(JSON.stringify(await client.calculatePlayer(row.playerId))).toBe(
        JSON.stringify(row),
      );
      const authoritative =
        await f.deps.playerCheckoutCommands!.previewCheckout({
          playerId: row.playerId,
        });
      expect(JSON.stringify(await client.previewCheckout(row.playerId))).toBe(
        JSON.stringify(authoritative),
      );
      const app = createPrismApp({
        ...f.deps,
        authenticatedPrincipal: { role: "player_session", playerId: row.playerId },
      });
      const response = await app.request("/api/v1/player/billing-inputs");
      expect(response.status).toBe(200);
      const inputs = ((await response.json()) as any).data;
      const scoped = createLiveBillingCalculator(
        hydrateLiveBillingSnapshot(inputs.billingSnapshot),
      );
      expect(JSON.stringify(await scoped.previewCheckout(row.playerId))).toBe(
        JSON.stringify(authoritative),
      );
    }
    expect((await client.calculatePlayer("used")).estimatedTotal).toBe(32);
    expect((await client.calculatePlayer("discounted")).estimatedTotal).toBe(
      47,
    );
    expect(
      (await client.calculatePlayer("discounted")).sessions[0]!.elapsedMinutes,
    ).toBe(180);
    expect((await client.calculatePlayer("cashier")).paymentMode).toBe(
      "cashier",
    );
    // A tampered browser result cannot change the authoritative checkout total.
    const tampered = await client.calculatePlayer("used");
    tampered.estimatedTotal = 0;
    const checkout = await f.deps.playerCheckoutCommands!.checkout({
      playerId: "used",
      closeSessionsBeforeBalanceCheck: false,
    });
    expect(checkout.playerSettlement.total).toBe(centsOf(32));
  } finally {
    f.db.close();
  }
});

test("snapshot sanitizes device command details, honors grace activity and stays scoped to the shop", async () => {
  const f = fixture("2026-10-07T02:00:00Z");
  try {
    await f.repositories.pricingConfigs.save(f.rate);
    for (const name of ["machine", "door", "rejected", "expired"]) {
      const session = await f.player(name);
      f.db.run(
        "UPDATE sessions SET metadata_json=? WHERE shop_id='shop' AND id=?",
        [JSON.stringify({ secret: "do-not-export" }), session.id],
      );
      f.db.run(
        "INSERT INTO device_commands(shop_id,id,type,target_kind,executor_kind,player_id,status,payload_json,requested_at) VALUES('shop',?,?,'facility','home_assistant',?,?,?,'2026-10-07T02:01:00.000Z')",
        [
          name,
          name === "door" ? "door.open" : "power.on",
          name,
          name === "rejected" || name === "expired" ? name : "acked",
          JSON.stringify({ secret: "do-not-export" }),
        ],
      );
    }
    f.db.run(
      "INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES('other','machine','Other shop','active','2026-10-07T02:00:00.000Z')",
    );
    f.db.run(
      "INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES('other','foreign-holding','machine','currency','paid',9900)",
    );
    f.clock("2026-10-07T02:03:00Z");
    const rows = await f.deps.staffOperations.listLivePlayers({
      summary: true,
    });
    const raw = await f.deps.staffLiveBillingSnapshot!(
      rows.map((row) => row.playerId),
    );
    const sessionSql = f.reads.find((sql) =>
      sql.includes("AS device_operated"),
    )!;
    const plan = f.db
      .query(`EXPLAIN QUERY PLAN ${sessionSql}`)
      .all(
        "2026-10-07T02:03:00.000Z",
        JSON.stringify(rows.map((row) => row.playerId)),
      );
    expect(JSON.stringify(plan)).toContain(
      "idx_device_commands_player_requested",
    );
    expect(JSON.stringify(raw)).not.toContain("do-not-export");
    expect(raw.players.flatMap((player) => player.holdings)).toEqual([]);
    const client = createLiveBillingCalculator(
      hydrateLiveBillingSnapshot(JSON.parse(JSON.stringify(raw))),
      rows,
    );
    for (const row of await f.deps.staffOperations.listLivePlayers()) {
      expect(JSON.stringify(await client.calculatePlayer(row.playerId))).toBe(
        JSON.stringify(row),
      );
      const authoritative =
        await f.deps.playerCheckoutCommands!.previewCheckout({
          playerId: row.playerId,
        });
      expect(JSON.stringify(await client.previewCheckout(row.playerId))).toBe(
        JSON.stringify(authoritative),
      );
      const app = createPrismApp({
        ...f.deps,
        authenticatedPrincipal: { role: "player_session", playerId: row.playerId },
      });
      const response = await app.request("/api/v1/player/billing-inputs");
      expect(response.status).toBe(200);
      const inputs = ((await response.json()) as any).data;
      const scoped = createLiveBillingCalculator(
        hydrateLiveBillingSnapshot(inputs.billingSnapshot),
      );
      expect(JSON.stringify(await scoped.previewCheckout(row.playerId))).toBe(
        JSON.stringify(authoritative),
      );
    }
    expect((await client.calculatePlayer("machine")).estimatedTotal).toBe(18);
    expect((await client.calculatePlayer("door")).estimatedTotal).toBe(0);
    expect((await client.calculatePlayer("rejected")).estimatedTotal).toBe(0);
    expect((await client.calculatePlayer("expired")).estimatedTotal).toBe(0);
  } finally {
    f.db.close();
  }
});

test("many different publications still use bounded bulk reads and preserve each visit's price", async () => {
  const f = fixture("2026-10-07T02:00:00Z");
  try {
    for (let i = 0; i < 15; i++) {
      await f.repositories.pricingConfigs.save({
        ...f.rate,
        name: `Version ${i}`,
        provider: {
          ...f.rate.provider,
          rules: f.rate.provider.rules.map((rule) => ({
            ...rule,
            pricing: { ...rule.pricing, unitPrice: i + 1 },
          })),
        },
      });
      await f.player(`p${i}`);
    }
    f.clock("2026-10-07T03:00:00Z");
    const rows = await f.deps.staffOperations.listLivePlayers({
      summary: true,
    });
    f.reads.length = 0;
    const raw = await f.deps.staffLiveBillingSnapshot!(
      rows.map((row) => row.playerId),
    );
    expect(f.reads).toHaveLength(9);
    expect(raw.pricingReleases).toHaveLength(15);
    const client = createLiveBillingCalculator(
      hydrateLiveBillingSnapshot(JSON.parse(JSON.stringify(raw))),
      rows,
    );
    for (let i = 0; i < 15; i++)
      expect((await client.calculatePlayer(`p${i}`)).estimatedTotal).toBe(
        i + 1,
      );
  } finally {
    f.db.close();
  }
});

test("browser checkout quotes match authoritative preview fields for pinned rules, caps and asset effects", async () => {
  const f = fixture();
  try {
    await f.repositories.pricingConfigs.save(f.rate);
    await f.player("p");
    f.clock("2026-10-07T10:00:00Z");
    const raw = await f.deps.billingInputs!(["p"]);
    const calculator = createLiveBillingCalculator(
      hydrateLiveBillingSnapshot(JSON.parse(JSON.stringify(raw))),
    );
    const server = await f.deps.playerCheckoutCommands!.previewCheckout({
      playerId: "p",
    });
    const client = await calculator.previewCheckout("p");
    expect(JSON.parse(JSON.stringify(client))).toEqual(
      JSON.parse(JSON.stringify(server)),
    );
    expect(client.settlementPreview.total).toBe(centsOf(2790));
    expect(client.settlementPreview.previewedAt.toISOString()).toBe(
      raw.capturedAt.toISOString(),
    );
    await expect(calculator.previewCheckout("other")).rejects.toThrow(
      "Player not found.",
    );
  } finally {
    f.db.close();
  }
});

test("billing input endpoints isolate player/shops, permit viewer reads and never run quotes or write rows", async () => {
  const f = fixture();
  try {
    await f.repositories.pricingConfigs.save(f.rate);
    await f.player("one");
    await f.player("two");
    const before = f.db.query("SELECT total_changes() AS n").get();
    const original = f.deps.playerCheckoutCommands!.previewCheckout;
    let quotes = 0;
    f.deps.playerCheckoutCommands!.previewCheckout = async (input) => {
      quotes++;
      return original(input);
    };
    const request = (
      path: string,
      principal: import("@prism/server-hono").Principal,
    ) =>
      createPrismApp({ ...f.deps, authenticatedPrincipal: principal }).request(
        path,
      );
    const player: import("@prism/server-hono").Principal = {
      role: "player_session",
      playerId: "one",
    };
    const response = await request(
      "/api/v1/player/billing-inputs?playerId=two",
      player,
    );
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.playerId).toBe("one");
    expect(data.billingSnapshot.players.map((p: any) => p.playerId)).toEqual([
      "one",
    ]);
    expect(
      (await request("/api/v1/staff/players/two/billing-inputs", player))
        .status,
    ).toBe(403);
    expect(
      (await request("/api/v1/player/billing-inputs", { role: "integration" }))
        .status,
    ).toBe(403);
    expect((await request("/api/v1/player/billing-inputs", { role: "player", playerId: "one" })).status).toBe(403);
    const viewer: import("@prism/server-hono").Principal = {
      role: "staff",
      staffId: "viewer",
      staffRole: "viewer",
    };
    expect(
      (await request("/api/v1/staff/players/two/billing-inputs", viewer))
        .status,
    ).toBe(200);
    expect(
      (await request("/api/v1/staff/players/missing/billing-inputs", viewer))
        .status,
    ).toBe(404);
    const unavailable = await createPrismApp({
      ...f.deps,
      billingInputs: undefined,
      authenticatedPrincipal: player,
    }).request("/api/v1/player/billing-inputs");
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe(
      "CLIENT_BILLING_UNAVAILABLE",
    );
    expect(quotes).toBe(0);
    expect(f.db.query("SELECT total_changes() AS n").get()).toEqual(before);
  } finally {
    f.db.close();
  }
});
