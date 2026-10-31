import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import type { AppBindings } from "../src/bindings.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { createCardStore } from "../src/resources/cards.js";
import { cardsRouter } from "../src/routes/platform/cards.js";

const KEY = "test-card-key";
const CARD = "01234567890123456789";
const OTHER_CARD = "98765432109876543210";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("PRAGMA foreign_keys=ON");
  for (const id of ["u1", "u2"])
    sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES (?,'user',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [id]);
  for (const shop of ["shop1", "shop2", "shop3"]) {
    sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES (?,?,?,0,0,80,'u1')", [shop, shop, shop]);
    for (const player of ["p1", "p2"])
      sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,?,?,'active',?)", [shop, player, player, new Date().toISOString()]);
  }
  for (const shop of ["shop1", "shop2"])
    sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES (?,'u1','p1',CURRENT_TIMESTAMP)", [shop]);
  sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop3','u1','p2',CURRENT_TIMESTAMP)");
  sqlite.run("INSERT INTO cards(id,user_id,label,access_code) VALUES ('card','u1','Main',?),('other-card','u1','Other',?),('foreign-card','u2','Other account',?)", [CARD, OTHER_CARD, CARD]);
  const db = createD1DatabaseFromSqlite(sqlite);
  const store = (shop: string) => createCardStore(db, shop, KEY);
  for (const shop of ["shop1", "shop2", "shop3"])
    await store(shop).bind({ playerId: "p1", card: { type: "aime", accessCode: CARD }, source: "scan" });
  await store("shop1").bind({ playerId: "p1", card: { type: "aime", accessCode: OTHER_CARD }, source: "reader" });
  // Stale plaintext bindings must not resurrect the deleted credential.
  for (const shop of ["shop1", "shop2", "shop3"])
    sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,'p1','aime',?,?)", [shop, CARD, new Date().toISOString()]);
  sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop1','p1','onebot','12345',?)", [new Date().toISOString()]);
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("user", { id: "u1", username: "test", displayName: "Test", role: "user", bannedAt: null });
    await next();
  });
  // Keep deliberate storage failures quiet; assert the response and persisted rows.
  app.onError(() => new Response("Storage failed", { status: 500 }));
  app.route("/cards", cardsRouter);
  const remove = (id = "card", key: string | undefined = KEY) => app.request(`/cards/${id}`, { method: "DELETE" }, {
    DB: db, APP_ORIGIN: "https://example.test", URL_ENCRYPTION_KEY: key,
  });
  const count = (table: string) => (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { sqlite, store, remove, count };
}

describe("deleting an account card", () => {
  it("revokes matching credentials across owned profiles without touching other cards or players", async () => {
    const { sqlite, store, remove } = await fixture();
    expect((await remove()).status).toBe(200);
    expect(sqlite.query("SELECT id FROM cards ORDER BY id").all()).toEqual([{ id: "foreign-card" }, { id: "other-card" }]);
    expect(await store("shop1").playerOf(CARD)).toBeNull();
    expect(await store("shop2").playerOf(CARD)).toBeNull();
    expect(await store("shop2").latestOf("p1")).toBeNull();
    expect(await store("shop1").latestOf("p1")).toBe(OTHER_CARD);
    expect(await store("shop3").playerOf(CARD)).toBe("p1");
    expect(sqlite.query("SELECT shop_id,provider,subject FROM player_identities ORDER BY shop_id").all()).toEqual([
      { shop_id: "shop1", provider: "onebot", subject: "12345" },
      { shop_id: "shop3", provider: "aime", subject: CARD },
    ]);
    // Deleting again is harmless. Explicitly adding the card later remains possible.
    expect((await remove()).status).toBe(200);
    expect(await store("shop2").bind({ playerId: "p1", card: { type: "aime", accessCode: CARD }, source: "reader" })).toBe("bound");
  });

  it("does not revoke a missing card or a card belonging to another account", async () => {
    const { remove, count } = await fixture();
    for (const id of ["missing", "foreign-card"]) expect((await remove(id)).status).toBe(200);
    expect(count("cards")).toBe(3);
    expect(count("player_cards")).toBe(4);
    expect(count("player_identities")).toBe(4);
  });

  it("rolls back all deletions if the account card cannot be deleted", async () => {
    const { sqlite, remove, count } = await fixture();
    sqlite.run("CREATE TRIGGER reject_card_delete BEFORE DELETE ON cards BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    expect((await remove()).status).toBe(500);
    expect(count("cards")).toBe(3);
    expect(count("player_cards")).toBe(4);
    expect(count("player_identities")).toBe(4);
  });

  it("keeps the account card when shop credentials cannot be revoked without the key", async () => {
    const { remove, count } = await fixture();
    expect((await remove("card", "")).status).toBe(500);
    expect(count("cards")).toBe(3);
    expect(count("player_cards")).toBe(4);
  });

  it("allows deletion without a key when the account has no shop profiles", async () => {
    const { sqlite, remove } = await fixture();
    sqlite.run("DELETE FROM shop_player_accounts WHERE user_id = 'u1'");
    expect((await remove("card", "")).status).toBe(200);
    expect(sqlite.query("SELECT id FROM cards WHERE id='card'").get()).toBeNull();
  });
});
