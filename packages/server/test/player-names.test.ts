import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createD1Executor } from "@prism/adapter-d1";
import { isPlaceholderPlayerName } from "@prism/core";
import { createSqlReadModels } from "@prism/storage-sql";
import { sha256 } from "../src/crypto.js";
import { createD1DatabaseFromSqlite, initializeLocalDatabase } from "../src/local-server.js";
import { getOrCreateShopDependencies } from "../src/middleware/tenant.js";
import { runBotCommand } from "../src/resources/bot-commands.js";
import { capabilities } from "../src/resources/capabilities/catalog.js";
import { chatNames, recordChatNames } from "../src/resources/player-names.js";
import { parseBotFrame } from "../src/durable-objects/shop-hub-bot.js";
import { eventPlayer } from "../src/resources/shop-events.js";

const SHOP = "shop";

function fixture() {
  const sqlite = new Database(":memory:");
  initializeLocalDatabase(sqlite);
  sqlite.run("PRAGMA foreign_keys=OFF");
  const player = (id: string, name: string, identities: Array<[string, string, string?]>) => {
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES (?,?,?,'active','2026-01-01')", [SHOP, id, name]);
    identities.forEach(([provider, subject], index) => sqlite.run(
      "INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES (?,?,?,?,?)",
      [SHOP, id, provider, subject, `2026-01-0${index + 1}`],
    ));
  };
  const name = (id: string) => (sqlite.query("SELECT display_name FROM players WHERE id = ?").get(id) as { display_name: string }).display_name;
  const identityName = (provider: string, subject: string) =>
    (sqlite.query("SELECT display_name FROM player_identities WHERE provider = ? AND subject = ?").get(provider, subject) as { display_name: string | null }).display_name;
  return { sqlite, db: createD1DatabaseFromSqlite(sqlite), player, name, identityName };
}

describe("what chat platforms call a shop's players", () => {
  it("tells a stand-in name from a real one", () => {
    for (const name of ["", "  ", "玩家", "Player 75"]) expect(isPlaceholderPlayerName(name)).toBe(true);
    const identity = { provider: "onebot", subject: "12345" };
    for (const name of ["12345", "onebot:12345", "onebot 12345"]) expect(isPlaceholderPlayerName(name, identity)).toBe(true);
    for (const name of ["小明", "Player One", "Player 75 小号"]) expect(isPlaceholderPlayerName(name, identity)).toBe(false);
  });

  it("keeps each platform's name on its own identity, and fills only a stand-in player name", async () => {
    const { db, player, name, identityName } = fixture();
    player("imported", "Player 75", [["onebot", "75"]]);
    player("named", "店里叫他阿明", [["onebot", "1"], ["discord", "d1"]]);
    player("idOnly", "onebot:9", [["onebot", "9"]]);
    await recordChatNames(db, SHOP, [
      { provider: "onebot", subject: "75", name: "雾雪" },
      { provider: "onebot", subject: "1", name: "QQ 小明" },
      { provider: "discord", subject: "d1", name: "Ming" },
      { provider: "onebot", subject: "9", name: "九号" },
      // Someone the shop does not know is not kept.
      { provider: "onebot", subject: "404", name: "路人" },
    ]);
    expect(name("imported")).toBe("雾雪");
    expect(name("idOnly")).toBe("九号");
    // A real name stays; each platform's name is on its own identity, so neither undoes the other.
    expect(name("named")).toBe("店里叫他阿明");
    expect(identityName("onebot", "1")).toBe("QQ 小明");
    expect(identityName("discord", "d1")).toBe("Ming");
    await recordChatNames(db, SHOP, [{ provider: "onebot", subject: "1", name: "QQ 新名字" }]);
    expect(identityName("onebot", "1")).toBe("QQ 新名字");
    expect(identityName("discord", "d1")).toBe("Ming");
    // Once filled, the player's name is theirs: a later chat name does not change it.
    await recordChatNames(db, SHOP, [{ provider: "onebot", subject: "75", name: "雾雪改名" }]);
    expect(name("imported")).toBe("雾雪");
    expect(identityName("onebot", "75")).toBe("雾雪改名");
  });

  it("gives a bot each identity's name with the player it speaks of", async () => {
    const { db, player } = fixture();
    player("p", "Player 75", [["onebot", "75"], ["discord", "d"]]);
    await recordChatNames(db, SHOP, [{ provider: "onebot", subject: "75", name: "雾雪" }]);
    expect((await eventPlayer(db, SHOP, "p"))!.identities).toEqual([
      { provider: "onebot", subject: "75", name: "雾雪" },
      { provider: "discord", subject: "d" },
    ]);
  });

  it("reads a bot's report of names, keeping only well-formed ones, each identity once", () => {
    expect(chatNames([
      { provider: "OneBot", subject: " 1 ", name: "  一号  " },
      { provider: "onebot", subject: "1", name: "一号改" },
      { provider: "onebot", subject: "", name: "空" },
      { provider: "bad provider", subject: "2", name: "x" },
      { provider: "onebot", subject: "3", name: "   " },
      "nonsense",
    ])).toEqual([{ provider: "onebot", subject: "1", name: "一号改" }]);
    expect(parseBotFrame(JSON.stringify({ type: "names", names: [{ provider: "onebot", subject: "1", name: "一号" }] })))
      .toEqual({ type: "names", names: [{ provider: "onebot", subject: "1", name: "一号" }] });
  });

  it("saves the sender's chat name on /bind and exposes it from staffQueries.listPlayers", async () => {
    const { sqlite, db, player, name, identityName } = fixture();
    const now = "2026-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    const code = "23456789";
    sqlite.run("INSERT INTO users(id, role, created_at, updated_at) VALUES ('u1', 'user', ?, ?)", [now, now]);
    player("p1", "Player 1", []);
    sqlite.run("INSERT INTO player_identities (shop_id, subject, player_id, created_at, provider) VALUES (?, 'u1', 'p1', ?, 'web-account')", [SHOP, now]);
    sqlite.run("INSERT INTO platform_binding_codes(shop_id, id, user_id, code_hash, expires_at, created_at) VALUES (?, 'c1', 'u1', ?, ?, ?)", [
      SHOP,
      await sha256(code),
      future,
      now,
    ]);

    const shop = {
      id: SHOP,
      public_id: SHOP,
      name: "Test Shop",
      latitude: 31.23,
      longitude: 121.47,
      radius_meters: 100,
      cashier_enabled: 0,
      auto_register: 1,
      identity_binding_required: 1,
      checkin_geo: 0,
      checkout_geo: 0,
      machine_geo: 0,
      bot_contact: "",
      time_zone: "Asia/Shanghai",
      hero_url: null,
    };
    const botConfig = capabilities.bot.config.parse({ tokenId: "tok1" });
    const { tokenId: _tok, doorResourceId: _door, ...settings } = botConfig;

    await runBotCommand({
      env: { DB: db, APP_ORIGIN: "https://prism.test" } as never,
      waitUntil: () => {},
      shop,
      deps: getOrCreateShopDependencies(db, shop),
      bot: { id: "bot1", name: "Shop Bot", enabled: true, config: botConfig },
      view: {
        bot: { id: "bot1", name: "Shop Bot" },
        settings,
        billingEnabled: true,
        currencyName: "点券",
        staff: [],
        door: null,
        tables: [],
      },
      from: { provider: "onebot", subject: "1015929452", name: "雾雪" },
      channel: "private:1015929452",
      name: "bind",
      args: [code],
    });

    expect(identityName("onebot", "1015929452")).toBe("雾雪");
    expect(name("p1")).toBe("雾雪");

    const queries = createSqlReadModels({ executor: createD1Executor(db, SHOP), now: () => new Date() });
    const players = await queries.staffQueries.listPlayers({ playerIds: ["p1"] });
    // The account link is the profile's `web-account` identity; the chat identity keeps its name.
    expect(players[0]?.identities?.map((i) => ({ provider: i.provider, subject: i.subject, displayName: i.displayName }))).toEqual([
      { provider: "web-account", subject: "u1", displayName: undefined },
      { provider: "onebot", subject: "1015929452", displayName: "雾雪" },
    ]);
    sqlite.close();
  });
});
