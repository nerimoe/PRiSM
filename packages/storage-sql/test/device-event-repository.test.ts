import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { DeviceEvent, DeviceOperation } from "@prism/core";
import type { SqlValue } from "../src/repositories";
import { createDeviceEventRepository, sqliteSchema, type SqlExecutor } from "../src/index";

function executorFor(db: Database): SqlExecutor {
  return {
    shopId: "shop",
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return (db.query(sql).get(...(params as SqlValue[])) as T | null) ?? null;
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return db.query(sql).all(...(params as SqlValue[])) as T[];
    },
    async run(sql: string, params: readonly SqlValue[] = []) {
      db.query(sql).run(...(params as SqlValue[]));
    },
    async batch(statements) {
      db.transaction(() => {
        for (const statement of statements) db.query(statement.sql).run(...((statement.params ?? []) as SqlValue[]));
      })();
    },
  };
}

function fixture() {
  const db = new Database(":memory:");
  for (const statement of sqliteSchema) db.run(statement);
  db.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','p1','P1','active','2026-01-01T00:00:00.000Z')");
  return { db, repo: createDeviceEventRepository(executorFor(db)) };
}

let seq = 0;
function event(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    deviceId: "m1",
    capability: "power",
    kind: "change",
    name: "power",
    operationId: null,
    parentOperationId: null,
    origin: "observer",
    playerId: null,
    staffId: null,
    payload: {},
    occurredAt: new Date(Date.UTC(2026, 1, 1, 10, 0, seq)),
    ...overrides,
  };
}

function operation(overrides: Partial<DeviceOperation> = {}): DeviceOperation {
  return {
    id: "op1",
    deviceId: "m1",
    capability: "power",
    action: "power.on",
    parentId: null,
    playerId: "p1",
    staffId: null,
    status: "pending",
    countsAsPlay: true,
    failure: null,
    payload: {},
    requestedAt: new Date("2026-02-01T10:00:00.000Z"),
    settledAt: null,
    ...overrides,
  };
}

const powerState = (value: string) => ({
  deviceId: "m1",
  capability: "power",
  key: "power",
  value,
  authority: "observed" as const,
});

describe("device event repository", () => {
  it("pages tied timestamps without skipping events or accepting another device/shop's cursor", async () => {
    const { db, repo } = fixture();
    const at = new Date("2026-02-01T10:00:00.000Z");
    await repo.record({ events: ["a", "b", "c"].map((id) => event({ id, occurredAt: at })) });
    await repo.record({ events: [event({ id: "other-device", deviceId: "m2", occurredAt: at })] });
    const otherShop = createDeviceEventRepository({ ...executorFor(db), shopId: "other" });
    await otherShop.record({ events: [event({ id: "other-shop", occurredAt: at })] });
    const first = await repo.listEvents({ deviceId: "m1", limit: 2 });
    expect(first.map((e) => e.id)).toEqual(["c", "b"]);
    await repo.record({ events: [event({ id: "newer", occurredAt: new Date(at.getTime() + 1000) })] });
    expect((await repo.listEvents({ deviceId: "m1", limit: 2, before: first.at(-1)!.id })).map((e) => e.id)).toEqual(["a"]);
    for (const before of ["missing", "other-device", "other-shop"]) {
      expect(await repo.listEvents({ deviceId: "m1", limit: 2, before })).toEqual([]);
    }
  });

  it("records a change only when the value actually changes", async () => {
    const { repo } = fixture();
    await repo.record({ events: [], states: [{ write: powerState("on"), event: event({ payload: { from: null, to: "on" } }) }] });
    // A repeated observation of the same value adds nothing.
    await repo.record({ events: [], states: [{ write: powerState("on"), event: event({ payload: { from: "on", to: "on" } }) }] });
    await repo.record({ events: [], states: [{ write: powerState("off"), event: event({ payload: { from: "on", to: "off" } }) }] });

    const events = await repo.listEvents({ deviceId: "m1", limit: 10 });
    expect(events.map((e) => e.payload.to)).toEqual(["off", "on"]);
    const [state] = await repo.listState(["m1"]);
    expect(state).toMatchObject({ value: "off", authority: "observed", eventId: events[0]!.id });
  });

  it("keeps the changed_at of the last real change across repeated observations", async () => {
    const { repo } = fixture();
    const first = event();
    await repo.record({ events: [], states: [{ write: powerState("on"), event: first }] });
    await repo.record({ events: [], states: [{ write: powerState("on"), event: event() }] });
    const [state] = await repo.listState();
    expect(state!.changedAt).toEqual(first.occurredAt);
  });

  it("creates an operation with its request and settles it once", async () => {
    const { repo } = fixture();
    await repo.record({ events: [event({ kind: "request", name: "power.on", operationId: "op1" })], operation: operation() });
    await repo.record({
      events: [event({ kind: "result", name: "power.on", operationId: "op1", payload: { outcome: "ok" } })],
      settle: { operationId: "op1", status: "succeeded", failure: null, settledAt: new Date("2026-02-01T10:00:01.000Z") },
    });
    // A late failure cannot overturn a recorded success.
    await repo.record({
      events: [],
      settle: { operationId: "op1", status: "failed", failure: "late", settledAt: new Date("2026-02-01T10:00:09.000Z") },
    });
    expect(await repo.getOperation("op1")).toMatchObject({ status: "succeeded", failure: null });
  });

  it("writes nothing when a batch part fails", async () => {
    const { repo } = fixture();
    await repo.record({ events: [event({ id: "dup" })] });
    await expect(repo.record({
      events: [event({ id: "fresh" }), event({ id: "dup" })],
    })).rejects.toThrow();
    expect((await repo.listEvents({ deviceId: "m1", limit: 10 })).map((e) => e.id)).toEqual(["dup"]);
  });

  it("lists a player's operations in request order", async () => {
    const { repo } = fixture();
    await repo.record({ events: [], operation: operation({ id: "b", requestedAt: new Date("2026-02-02T00:00:00.000Z") }) });
    await repo.record({ events: [], operation: operation({ id: "a", requestedAt: new Date("2026-02-01T00:00:00.000Z") }) });
    expect((await repo.listOperationsByPlayer("p1")).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("keeps where an event came from, and says nothing for one that never said", async () => {
    const { repo } = fixture();
    await repo.record({ events: [
      event({ id: "old" }),
      event({ id: "said", kind: "request", name: "power.on", via: { channel: "bot", resourceId: "bot-1" } }),
      event({ id: "page", kind: "request", name: "coin", via: { channel: "page", resourceId: null } }),
    ] });
    const via = new Map((await repo.listEvents({ deviceId: "m1", limit: 10 })).map((e) => [e.id, e.via]));
    expect(via.get("old")).toBeNull();
    expect(via.get("said")).toEqual({ channel: "bot", resourceId: "bot-1" });
    expect(via.get("page")).toEqual({ channel: "page", resourceId: null });
  });

  it("returns the events it wrote, without a change whose state did not move", async () => {
    const { repo } = fixture();
    const first = event({ id: "c1", payload: { to: "on" } });
    expect((await repo.record({ events: [], states: [{ write: powerState("on"), event: first }] })).map((e) => e.id))
      .toEqual(["c1"]);
    const signal = event({ id: "s1", kind: "signal", name: "card.consumed", capability: "hinata_io" });
    const written = await repo.record({
      events: [signal],
      states: [
        { write: powerState("on"), event: event({ id: "c2", payload: { to: "on" } }) },
        { write: { ...powerState("cool"), capability: "climate", key: "climate" }, event: event({ id: "c3", capability: "climate", name: "climate" }) },
      ],
    });
    expect(written.map((e) => e.id)).toEqual(["s1", "c3"]);
  });

  it("lists shop-wide events across resources and non-resource shop operations with scope, category, and cursor filters", async () => {
    const { db, repo } = fixture();
    const t1 = new Date("2026-02-01T10:00:01.000Z");
    const t2 = new Date("2026-02-01T10:00:02.000Z");
    const t3 = new Date("2026-02-01T10:00:03.000Z");
    const t4 = new Date("2026-02-01T10:00:04.000Z");
    await repo.record({
      events: [
        event({ id: "dev-1", deviceId: "m1", capability: "power", kind: "request", name: "power.on", playerId: "p1", occurredAt: t1 }),
        event({ id: "chk-fail", deviceId: null, capability: "shop", kind: "signal", name: "checkout.refused", origin: "platform", playerId: "p1", occurredAt: t2, payload: { code: "INSUFFICIENT_BALANCE" } }),
        event({ id: "wallet-1", deviceId: null, capability: "shop", kind: "signal", name: "wallet.adjusted", origin: "platform", playerId: "p1", staffId: "st-1", occurredAt: t3 }),
        event({ id: "chk-ok", deviceId: null, capability: "shop", kind: "signal", name: "checkout.settled", origin: "platform", playerId: "p1", occurredAt: t4 }),
      ],
    });
    const otherShop = createDeviceEventRepository({ ...executorFor(db), shopId: "other" });
    await otherShop.record({
      events: [event({ id: "other-chk", deviceId: null, capability: "shop", kind: "signal", name: "checkout.settled", origin: "platform", occurredAt: t4 })],
    });

    const all = await repo.listShopEvents!({ scope: "all", limit: 10 });
    expect(all.map((e) => e.id)).toEqual(["chk-ok", "wallet-1", "chk-fail", "dev-1"]);

    const nonResource = await repo.listShopEvents!({ scope: "non_resource", limit: 10 });
    expect(nonResource.map((e) => e.id)).toEqual(["chk-ok", "wallet-1", "chk-fail"]);

    const resourceOnly = await repo.listShopEvents!({ scope: "resource", limit: 10 });
    expect(resourceOnly.map((e) => e.id)).toEqual(["dev-1"]);

    const checkouts = await repo.listShopEvents!({ scope: "non_resource", names: ["checkout.settled", "checkout.refused"], limit: 10 });
    expect(checkouts.map((e) => e.id)).toEqual(["chk-ok", "chk-fail"]);

    const page1 = await repo.listShopEvents!({ scope: "non_resource", limit: 2 });
    expect(page1.map((e) => e.id)).toEqual(["chk-ok", "wallet-1"]);
    const page2 = await repo.listShopEvents!({ scope: "non_resource", limit: 2, before: page1.at(-1)!.id });
    expect(page2.map((e) => e.id)).toEqual(["chk-fail"]);

    expect(await repo.listShopEvents!({ scope: "non_resource", limit: 5, before: "other-chk" })).toEqual([]);
  });
});
