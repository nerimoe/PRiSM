import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { centsOf } from "@prism/core";
import { createSqlReadModels, sqliteSchema } from "@prism/storage-sql";
import { createBunSqliteExecutor, createSqliteRepositories } from "../src";

test("latest receipt persists a complete checkout, isolates players and shops, and supports pre-snapshot bills", async () => {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of sqliteSchema) db.run(sql);
  const now = () => new Date("2026-09-20T10:00:00Z");
  const queries = (shopId: string) => createSqlReadModels({ executor: createBunSqliteExecutor(db, shopId), now }).playerQueries;
  const repo = createSqliteRepositories({ db, shopId: "shop", now, id: () => crypto.randomUUID() });
  await repo.players.save({ id: "player", displayName: "Player", status: "active", createdAt: now() });
  expect(await queries("shop").getLatestPlayerCheckout!("player")).toBeNull();
  const records = [];
  const sessions = [];
  for (const id of ["entry", "table"]) {
    const session = { id, playerId: "player", startedAt: new Date("2026-09-20T09:00:00Z"), endedAt: now(), status: "closed" as const, paymentStatus: "paid" as const, label: id };
    await repo.sessions.save(session);
    const chargeItems = [{ id: `charge-${id}`, source: "time", label: id, amount: centsOf(12) }];
    sessions.push({ sessionId: id, ...session, chargeItems });
    records.push({ settlement: { sessionId: id, subtotal: centsOf(12), total: centsOf(12), status: "settled" as const, settledAt: now() }, chargeItems, adjustments: [] });
  }
  const timeline = { tracks: sessions.map((session, lane) => ({ id: session.id, name: session.label, lane, color: lane, startedAt: session.startedAt.toISOString(), endedAt: session.endedAt.toISOString() })), events: [], totals: [{ name: "entry", amount: 12 }, { name: "table", amount: 12 }] };
  await repo.settlements.saveCheckout!({ id: "checkout", playerId: "player", subtotal: centsOf(24), total: centsOf(24), status: "settled", settledAt: now(), timeline }, records);
  const latest = await queries("shop").getLatestPlayerCheckout!("player");
  expect(latest?.playerSettlement.total).toBe(24);
  expect(latest?.chargeItems).toHaveLength(2);
  expect(latest?.timeline).toEqual(timeline);
  expect(await queries("other").getLatestPlayerCheckout!("player")).toBeNull();
  expect(await queries("shop").getLatestPlayerCheckout!("other")).toBeNull();
  db.run("DELETE FROM checkout_timelines");
  await repo.system.setAppSetting("store.profile", { timeZone: "Asia/Tokyo" });
  const legacy = await queries("shop").getLatestPlayerCheckout!("player");
  expect(legacy?.playerSettlement.total).toBe(24);
  expect(legacy?.timeline.tracks).toHaveLength(2);
  expect(legacy?.timeline.events[0]?.time).toBe("19:00");
  expect(legacy?.timeline.events.flatMap(event => event.entries).filter(entry => entry.kind === "end")).toHaveLength(2);
  await repo.settlements.saveCheckout!({ id: "new-checkout", playerId: "player", subtotal: centsOf(0), total: centsOf(0), status: "settled", settledAt: new Date("2026-09-21T10:00:00Z"), timeline: { tracks: [], events: [], totals: [] } }, []);
  expect((await queries("shop").getLatestPlayerCheckout!("player"))?.playerSettlement.total).toBe(0);
  db.close();
});
