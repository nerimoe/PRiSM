import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import type { AppBindings, Env } from "../src/bindings.js";
import { createApp } from "../src/app.js";
import { sha256 } from "../src/crypto.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { bindReaderCard } from "../src/resources/card-capture.js";
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
    sqlite.run("INSERT INTO player_identities (shop_id, subject, player_id, created_at, provider) VALUES (?,'u1','p1',CURRENT_TIMESTAMP, 'web-account')", [shop]);
  sqlite.run("INSERT INTO player_identities (shop_id, subject, player_id, created_at, provider) VALUES ('shop3','u1','p2',CURRENT_TIMESTAMP, 'web-account')");
  sqlite.run("INSERT INTO cards(id,user_id,label,access_code) VALUES ('card','u1','Main',?),('other-card','u1','Other',?),('foreign-card','u2','Other account',?)", [CARD, OTHER_CARD, CARD]);
  const db = createD1DatabaseFromSqlite(sqlite);
  const store = (shop: string) => createCardStore(db, shop, KEY);
  for (const shop of ["shop1", "shop2", "shop3"])
    await store(shop).bind({ playerId: "p1", card: { type: "aime", accessCode: CARD }, source: "scan" });
  await store("shop1").bind({ playerId: "p1", card: { type: "aime", accessCode: OTHER_CARD }, source: "reader" });
  // An identity may have the same value as an independently bound card.
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
  // Account links are identities too; count the cards and chat identities the test is about.
  const count = (table: string) =>
    (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}${table === "player_identities" ? " WHERE provider <> 'web-account'" : ""}`).get() as { n: number }).n;
  const env = { DB: db, APP_ORIGIN: "https://example.test", URL_ENCRYPTION_KEY: KEY } as unknown as Env;
  return { sqlite, db, app, env, store, remove, count };
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
    expect(sqlite.query("SELECT shop_id,provider,subject FROM player_identities WHERE provider <> 'web-account' ORDER BY shop_id, provider").all()).toEqual([
      { shop_id: "shop1", provider: "aime", subject: CARD },
      { shop_id: "shop1", provider: "onebot", subject: "12345" },
      { shop_id: "shop2", provider: "aime", subject: CARD },
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
    sqlite.run("DELETE FROM player_identities WHERE provider = 'web-account' AND subject = 'u1'");
    expect((await remove("card", "")).status).toBe(200);
    expect(sqlite.query("SELECT id FROM cards WHERE id='card'").get()).toBeNull();
  });
});

describe("manual card addition disabled & reader/MuNET flows preserved", () => {
  it("rejects manual card-number creation on cardsRouter and /api/v1/cards without inserting a card", async () => {
    const { sqlite, db, app, env, count } = await fixture();
    const res = await app.request(
      "/cards",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "New Card", accessCode: "11112222333344445555" }),
      },
      env,
    );
    expect(res.status).toBe(410);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("MANUAL_CARD_ADD_DISABLED");
    expect(json.error.message).toContain("MuNET");
    expect(json.error.message).toContain("读卡器");
    expect(count("cards")).toBe(3);

    // Full app route enforces auth and returns localized notice/message.
    sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('s1','u1',?,?)", [
      await sha256("user-token"),
      new Date(Date.now() + 86_400_000).toISOString(),
    ]);
    const fullApp = createApp();
    const unauth = await fullApp.fetch(
      new Request("https://example.test/api/v1/cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "New Card", accessCode: "11112222333344445555" }),
      }),
      env,
    );
    expect(unauth.status).toBe(401);

    const enRes = await fullApp.fetch(
      new Request("https://example.test/api/v1/cards", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer user-token",
          "accept-language": "en-US",
        },
        body: JSON.stringify({ label: "New Card", accessCode: "11112222333344445555" }),
      }),
      env,
    );
    expect(enRes.status).toBe(410);
    const enJson = (await enRes.json()) as { error: { code: string; message: string; notice: { code: string } } };
    expect(enJson.error.code).toBe("MANUAL_CARD_ADD_DISABLED");
    expect(enJson.error.message).toContain("MuNET");
    expect(enJson.error.message).toContain("card reader");
    expect(enJson.error.notice.code).toBe("MANUAL_CARD_ADD_DISABLED");
    expect(count("cards")).toBe(3);
  });

  it("keeps listing cards, MuNET sync check, and store card-reader capture working", async () => {
    const { db, app, env, store } = await fixture();
    const readerCard = "11112222333344445555";
    const captured = await bindReaderCard(
      db,
      KEY,
      { id: "cap-1", shopId: "shop1", userId: "u1", playerId: "p1", expiresAt: Date.now() + 15_000 },
      { type: "aime", accessCode: readerCard },
    );
    expect(captured).toEqual({ status: "added", cardType: "aime" });
    expect(await store("shop1").playerOf(readerCard)).toBe("p1");

    const listRes = await app.request("/cards", { method: "GET" }, env);
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { cards: Array<{ accessCode: string; source: string }> };
    expect(listJson.cards.some((card) => card.accessCode === readerCard && card.source === "reader")).toBe(true);

    const syncRes = await app.request("/cards/sync", { method: "POST" }, env);
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as { authorizationRequired: boolean; cards: Array<{ accessCode: string }> };
    expect(syncJson.authorizationRequired).toBe(true);
    expect(syncJson.cards.some((card) => card.accessCode === readerCard)).toBe(true);
  });
});
