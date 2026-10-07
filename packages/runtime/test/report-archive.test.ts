import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { centsOf } from "@prism/core";
import { createSqlReadModels, sqliteSchema } from "@prism/storage-sql";
import {
  createBunSqliteExecutor,
  createSqliteRepositories,
} from "@prism/adapter-sqlite";
import { createPrismRuntimeDependencies } from "../src";
import { createPrismApp } from "@prism/server-hono";
import type { Principal } from "@prism/server-hono";
import { readFileSync } from "node:fs";

const from = new Date("2026-10-01T00:00:00Z"),
  to = new Date("2026-11-01T00:00:00Z");
const range = { from, to, limit: 50 };
async function fixture() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  for (const sql of sqliteSchema) db.run(sql);
  let at = new Date("2026-10-07T03:00:00Z");
  const now = () => at;
  const repo = (shopId = "shop") =>
    createSqliteRepositories({
      db,
      shopId,
      now,
      id: () => crypto.randomUUID(),
    });
  const queries = (shopId = "shop") =>
    createSqlReadModels({ executor: createBunSqliteExecutor(db, shopId), now });
  const repositories = repo();
  await repositories.system.setAppSetting("store.profile", {
    timeZone: "Asia/Shanghai",
  });
  for (const shopId of ["shop", "other"]) {
    const r = repo(shopId);
    await r.players.save({
      id: "player",
      displayName: shopId,
      status: "active",
      createdAt: now(),
    });
    const records = [];
    for (const id of ["entry", "table"]) {
      await r.sessions.save({
        id,
        playerId: "player",
        startedAt: new Date("2026-10-07T01:00:00Z"),
        endedAt: new Date("2026-10-07T02:15:00Z"),
        status: "closed",
        paymentStatus: "paid",
      });
      records.push({
        settlement: {
          sessionId: id,
          subtotal: centsOf(12),
          total: centsOf(id === "entry" ? 7 : 12),
          status: "settled" as const,
          settledAt: now(),
        },
        chargeItems: [
          {
            id: `charge-${id}`,
            source: "old-plan",
            label: "历史收费",
            amount: centsOf(12),
          },
        ],
        adjustments:
          id === "entry"
            ? [
                {
                  id: "discount",
                  source: "discount",
                  label: "历史优惠",
                  amount: centsOf(-5),
                },
              ]
            : [],
      });
    }
    await r.settlements.saveCheckout!(
      {
        id: "bill",
        playerId: "player",
        subtotal: centsOf(24),
        total: centsOf(19),
        status: "settled",
        settledAt: now(),
      },
      records,
    );
    db.run(
      "INSERT INTO cashier_payments(shop_id,checkout_id,staff_id,method,collected_at) VALUES (?,'bill','collector','cash',?)",
      [shopId, now().toISOString()],
    );
  }
  {
    db.run(
      "INSERT INTO asset_definitions(shop_id,type,code,name) VALUES ('shop','currency','paid','余额')",
    );
    db.run(
      "INSERT INTO asset_holdings(shop_id,id,player_id,asset_type,asset_code,quantity) VALUES ('shop','holding','player','currency','paid',8100)",
    );
    db.run(
      "INSERT INTO pricing_history_entries(shop_id,id,player_id,pricing_config_id,provider_id,rule_id,rule_anchor_at,session_id,amount,created_at) VALUES ('shop','history','player','old-plan','old-plan','day',?,'entry',1200,?)",
      [now().toISOString(), now().toISOString()],
    );
    db.run(
      "INSERT INTO pricing_cap_history_entries(shop_id,id,player_id,cap_config_id,cap_rule_id,cap_anchor_at,included_pricing_config_ids_json,session_ids_json,amount,created_at) VALUES ('shop','cap-history','player','cap','day',?,'[\"old-plan\"]','[\"entry\",\"table\"]',1900,?)",
      [now().toISOString(), now().toISOString()],
    );
  }
  const runtime = createPrismRuntimeDependencies({
    repositories,
    queries: queries(),
    now,
    id: () => crypto.randomUUID(),
    coinCooldownMs: 0,
    pricingProviders: [],
    assetEffectProviders: [],
  });
  const app = (
    principal: Principal = {
      role: "staff",
      staffId: "manager",
      staffRole: "manager",
    },
  ) => createPrismApp({ ...runtime, authenticatedPrincipal: principal });
  const read = queries();
  return {
    db,
    repositories,
    repo,
    queries,
    read,
    runtime,
    app,
    advance: () => {
      at = new Date(+at + 60000);
    },
  };
}

test("whole bills group sessions and reuse historical receipts; archive only changes lists and revenue", async () => {
  const f = await fixture();
  try {
    const initial = await f.read.staffQueries.listReportCheckouts!(range);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      checkoutId: "bill",
      sessionCount: 2,
      durationMinutes: 150,
      subtotal: 24,
      total: 19,
      archived: false,
      externalPayment: {
        method: "cash",
        staffId: "collector",
        collectedAt: "2026-10-07T03:00:00.000Z",
      },
    });
    const detail = await f.read.staffQueries.getReportCheckout!("bill");
    const receipt = await f.read.playerQueries.getPlayerCheckout!(
      "player",
      "bill",
    );
    expect(detail!.receipt).toEqual(receipt!);
    expect(receipt?.chargeItems).toHaveLength(2);
    expect(receipt?.adjustments[0]?.amount).toBe(-5);
    expect(receipt?.timeline.events).not.toHaveLength(0);
    // Preserve millisecond boundaries rather than rounding 74m 59.999s up to 75m.
    f.db.run("UPDATE sessions SET started_at='2026-10-07T01:00:00.001Z' WHERE shop_id='shop'");
    expect((await f.read.staffQueries.listReportCheckouts!(range))[0]!.durationMinutes).toBe(148);
    f.db.run("UPDATE sessions SET started_at='2026-10-07T01:00:00.000Z' WHERE shop_id='shop'");
    const snapshot = () =>
      [
        "players",
        "sessions",
        "settlements",
        "player_checkouts",
        "settlement_charge_items",
        "settlement_adjustments",
        "asset_holdings",
        "cashier_payments",
        "pricing_history_entries",
        "pricing_cap_history_entries",
      ].map((t) => f.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all());
    const before = snapshot();
    const summary = await f.read.staffQueries.getReportsSummary!(range);
    expect(summary.revenueTotal).toBe(centsOf(19));
    expect(summary.sessionCount).toBe(2);
    await f.runtime.staffReportCommands!.setArchived({
      checkoutId: "bill",
      archived: true,
      staffId: "manager",
    });
    expect(await f.read.staffQueries.listReportCheckouts!(range)).toEqual([]);
    expect(
      (
        await f.read.staffQueries.listReportCheckouts!({
          ...range,
          archive: "archived",
        })
      )[0],
    ).toMatchObject({ total: 19, archived: true, updatedBy: "manager" });
    expect(await f.read.staffQueries.getReportsSummary!(range)).toEqual({
      ...summary,
      revenueTotal: centsOf(0),
    });
    expect(await f.read.staffQueries.listReportSettlements!(range)).toEqual([]);
    expect(
      (await f.read.staffQueries.listReportPlayers!(range))[0],
    ).toMatchObject({ revenueTotal: centsOf(0), settlementCount: 2 });
    expect(
      (await f.queries("other").staffQueries.listReportCheckouts!(range))[0]
        ?.archived,
    ).toBe(false);
    expect(
      await f.read.playerQueries.getPlayerCheckout!("player", "bill"),
    ).toEqual(receipt);
    expect(
      (await f.read.playerQueries.listPlayerCheckouts!("player", 0)).records,
    ).toHaveLength(1);
    const state = f.db.query("SELECT * FROM checkout_report_states").all();
    f.advance();
    await f.runtime.staffReportCommands!.setArchived({
      checkoutId: "bill",
      archived: true,
      staffId: "other-manager",
    });
    expect(f.db.query("SELECT * FROM checkout_report_states").all()).toEqual(
      state,
    );
    await f.runtime.staffReportCommands!.setArchived({
      checkoutId: "bill",
      archived: false,
      staffId: "owner",
    });
    expect(
      (await f.read.staffQueries.listReportCheckouts!(range))[0],
    ).toMatchObject({
      archived: false,
      updatedBy: "owner",
      updatedAt: "2026-10-07T03:01:00.000Z",
    });
    expect(await f.read.staffQueries.getReportsSummary!(range)).toEqual(
      summary,
    );
    expect(snapshot()).toEqual(before);
    // Both the new saved-timeline path and old reconstructed receipts are identical to the player's.
    f.db.run(
      "INSERT INTO checkout_timelines(shop_id,checkout_id,timeline_json) VALUES ('shop','bill',?)",
      [JSON.stringify(receipt!.timeline)],
    );
    expect(
      (await f.read.staffQueries.getReportCheckout!("bill"))!.receipt,
    ).toEqual(
      (await f.read.playerQueries.getPlayerCheckout!("player", "bill"))!,
    );
    expect(
      await f.queries("absent").staffQueries.getReportCheckout!("bill"),
    ).toBeNull();
    expect(
      await f
        .repo("absent")
        .reportArchives!.setArchived({
          checkoutId: "bill",
          archived: true,
          staffId: "attacker",
          at: from,
        }),
    ).toBe(false);
  } finally {
    f.db.close();
  }
});

test("archive API validates scope and role, uses the real staff actor, and paginates bills", async () => {
  const f = await fixture();
  try {
    const base = "/api/v1/staff/reports/checkouts";
    const request = (path: string, body?: unknown, principal?: Principal) =>
      f.app(principal).request(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const search = `?from=${from.toISOString()}&to=${to.toISOString()}`;
    expect((await request(search)).status).toBe(200);
    expect((await request(search + "&archive=wrong")).status).toBe(400);
    expect((await request("?from=broken")).status).toBe(400);
    expect((await request("/unknown")).status).toBe(404);
    expect((await request("/unknown/archive", { archived: true })).status).toBe(
      404,
    );
    expect((await request("/bill/archive", { archived: "true" })).status).toBe(
      400,
    );
    const viewer: Principal = {
      role: "staff",
      staffId: "viewer",
      staffRole: "viewer",
    };
    expect((await request("/bill", undefined, viewer)).status).toBe(200);
    expect(
      (await request("/bill/archive", { archived: true }, viewer)).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/bill/archive",
          { archived: true },
          { role: "integration" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/bill/archive",
          { archived: true },
          { role: "player", playerId: "player" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/bill/archive", { archived: true, staffId: "forged" }))
        .status,
    ).toBe(200);
    expect(
      f.db.query("SELECT updated_by FROM checkout_report_states").get(),
    ).toEqual({ updated_by: "manager" });
    expect((await (await request(search)).json()).data.records).toEqual([]);
    expect(
      (await (await request(search + "&archive=all")).json()).data.records,
    ).toHaveLength(1);
    expect((await request("/bill/archive", { archived: false })).status).toBe(
      200,
    );
    for (let n = 0; n < 51; n++)
      await f.repositories.settlements.saveCheckout!(
        {
          id: `empty-${String(n).padStart(2, "0")}`,
          playerId: "player",
          subtotal: centsOf(0),
          total: centsOf(0),
          status: "settled",
          settledAt: new Date("2026-10-07T03:00:00Z"),
        },
        [],
      );
    const a = (await (await request(search + "&limit=50")).json()).data;
    const b = (await (await request(search + "&limit=50&offset=50")).json())
      .data;
    expect(a.records).toHaveLength(50);
    expect(a.page.hasMore).toBe(true);
    expect(b.records).toHaveLength(2);
    expect(b.page.hasMore).toBe(false);
    expect(
      new Set([...a.records, ...b.records].map((r: any) => r.checkoutId)).size,
    ).toBe(52);
    expect(a.records[0]).toMatchObject({
      sessionCount: 0,
      startedAt: null,
      endedAt: null,
      total: 0,
    });
  } finally {
    f.db.close();
  }
});

test("0035 adds reporting metadata idempotently without changing old financial rows", async () => {
  const f = await fixture();
  try {
    f.db.run("DROP TABLE checkout_report_states");
    const before = f.db.query("SELECT * FROM player_checkouts").all();
    const sql = readFileSync(
      new URL(
        "../../../migrations/0035_checkout_report_states.sql",
        import.meta.url,
      ),
      "utf8",
    );
    f.db.run(
      "CREATE TABLE shop_data_exports(shop_id TEXT,status TEXT,expires_at TEXT)",
    );
    f.db.exec(sql);
    f.db.exec(sql);
    expect(f.db.query("SELECT * FROM player_checkouts").all()).toEqual(before);
    expect(f.db.query("SELECT * FROM checkout_report_states").all()).toEqual(
      [],
    );
    expect(
      (await f.read.staffQueries.listReportCheckouts!(range))[0]?.total,
    ).toBe(19);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.db.close();
  }
});
