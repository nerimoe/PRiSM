import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { isPlaceholderPlayerName } from "@prism/core";
import { createD1DatabaseFromSqlite, initializeLocalDatabase } from "../src/local-server.js";
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
});
