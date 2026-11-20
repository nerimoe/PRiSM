import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";

const migrations = resolve(import.meta.dir, "../../../migrations");
const run = (sqlite: Database, name: string) => {
  for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
};

describe("migration 0046: a bot has one announcement channel list", () => {
  it("merges the idle and event lists and keeps the idle warning on for bots that had one", () => {
    const sqlite = new Database(":memory:");
    sqlite.run("PRAGMA foreign_keys=OFF");
    const now = new Date().toISOString();
    sqlite.run(`
      CREATE TABLE device_capabilities(
        shop_id TEXT NOT NULL, device_id TEXT NOT NULL, capability TEXT NOT NULL,
        config_json TEXT NOT NULL, secret_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, device_id, capability))`);

    const bots: Record<string, string> = {
      // Both lists: they merge, and the idle warning stays on.
      both: JSON.stringify({
        tokenId: "t1", idleChannelIds: ["onebot:1", "onebot:2"], idleReminderMinutes: 5,
        eventChannelIds: ["onebot:2", "onebot:3"], announcePower: true,
      }),
      // Only a lead of 0 meant the store never wanted the warning.
      silent: JSON.stringify({ tokenId: "t2", idleChannelIds: ["onebot:4"], idleReminderMinutes: 0 }),
      // No idle list at all, only shop news.
      news: JSON.stringify({ tokenId: "t3", eventChannelIds: ["onebot:5"], announceStarts: true }),
      // Nothing configured yet.
      fresh: JSON.stringify({ tokenId: "t4" }),
    };
    for (const [id, config] of Object.entries(bots))
      sqlite.run("INSERT INTO device_capabilities VALUES ('shop', ?, 'bot', ?, '{}', ?, ?)", [id, config, now, now]);
    // Devices with the same field names are left alone.
    sqlite.run("INSERT INTO device_capabilities VALUES ('shop', 'm1', 'power', ?, '{}', ?, ?)",
      [JSON.stringify({ idleChannelIds: ["not-a-channel-list"] }), now, now]);

    run(sqlite, readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort().find((file) => file.startsWith("0046"))!);

    const configs = Object.fromEntries(
      sqlite.query("SELECT device_id AS id, config_json AS json FROM device_capabilities WHERE capability='bot'").all()
        .map((row) => [(row as { id: string }).id, JSON.parse((row as { json: string }).json)]),
    );
    expect(configs.both).toEqual({
      tokenId: "t1", idleReminderMinutes: 5, announcePower: true,
      announceChannelIds: ["onebot:1", "onebot:2", "onebot:3"], announceIdle: true,
    });
    expect(configs.silent).toEqual({
      tokenId: "t2", idleReminderMinutes: 0, announceChannelIds: ["onebot:4"], announceIdle: false,
    });
    expect(configs.news).toEqual({
      tokenId: "t3", announceStarts: true, announceChannelIds: ["onebot:5"], announceIdle: false,
    });
    expect(configs.fresh).toEqual({ tokenId: "t4", announceChannelIds: [], announceIdle: false });

    const untouched = sqlite.query("SELECT config_json AS json FROM device_capabilities WHERE device_id='m1'").get() as { json: string };
    expect(JSON.parse(untouched.json)).toEqual({ idleChannelIds: ["not-a-channel-list"] });
  });
});

describe("migration 0051: a bot announces by one list of rules", () => {
  it("turns each bot's groups and what it said there into its first rule, and drops what the rules replace", () => {
    const sqlite = new Database(":memory:");
    const now = new Date().toISOString();
    sqlite.run(`
      CREATE TABLE device_capabilities(
        shop_id TEXT NOT NULL, device_id TEXT NOT NULL, capability TEXT NOT NULL,
        config_json TEXT NOT NULL, secret_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, device_id, capability))`);
    const bots: Record<string, Record<string, unknown>> = {
      // A list of what it announces, with the switches the server kept beside it.
      listed: { tokenId: "t1", playerCommands: "readonly", idleReminderMinutes: 10, announceChannelIds: ["onebot:1", "onebot:2"],
        announceEvents: ["card", "request.power.on", "idle.reminder"], announceIdle: true, announcePower: false, announceStarts: false, announceCards: true, announceCoins: false },
      // Set before there was a list: only switches.
      switched: { tokenId: "t2", announceChannelIds: ["onebot:3"], announceEvents: null, announceIdle: true, announcePower: true, announceStarts: false, announceCards: false, announceCoins: true },
      // Somewhere to say it but nothing to say, and something to say but nowhere: neither said anything.
      quiet: { tokenId: "t3", announceChannelIds: ["onebot:4"], announceEvents: [] },
      homeless: { tokenId: "t4", announceChannelIds: [], announceEvents: ["card"] },
      fresh: { tokenId: "t5" },
    };
    for (const [id, config] of Object.entries(bots))
      sqlite.run("INSERT INTO device_capabilities VALUES ('shop', ?, 'bot', ?, '{}', ?, ?)", [id, JSON.stringify(config), now, now]);
    // Other capabilities are left alone.
    sqlite.run("INSERT INTO device_capabilities VALUES ('shop', 'm1', 'power', ?, '{}', ?, ?)", [JSON.stringify({ announceChannelIds: ["not-a-bot"] }), now, now]);

    run(sqlite, "0051_bot_announcement_rules.sql");

    const configs = Object.fromEntries(
      sqlite.query("SELECT device_id AS id, config_json AS json FROM device_capabilities").all()
        .map((row) => [(row as { id: string }).id, JSON.parse((row as { json: string }).json)]),
    );
    expect(configs.listed).toEqual({
      tokenId: "t1", playerCommands: "readonly", idleReminderMinutes: 10,
      announceRules: [{ events: ["card", "request.power.on", "idle.reminder"], sources: [], to: ["onebot:1", "onebot:2"], staff: false }],
    });
    expect(configs.switched).toEqual({
      tokenId: "t2",
      announceRules: [{ events: ["idle.reminder", "power.on", "power.off", "request.coin"], sources: [], to: ["onebot:3"], staff: false }],
    });
    expect(configs.quiet).toEqual({ tokenId: "t3", announceRules: [] });
    expect(configs.homeless).toEqual({ tokenId: "t4", announceRules: [] });
    expect(configs.fresh).toEqual({ tokenId: "t5", announceRules: [] });
    expect(configs.m1).toEqual({ announceChannelIds: ["not-a-bot"] });
    sqlite.close();
  });
});

describe("migration 0052: rules that warn of idle power-offs hear of maintenance too", () => {
  it("adds platform.maintenance once, only where the idle warning is heard", () => {
    const sqlite = new Database(":memory:");
    sqlite.run(`CREATE TABLE device_capabilities(shop_id TEXT, device_id TEXT, capability TEXT, config_json TEXT, PRIMARY KEY (shop_id, device_id, capability))`);
    const rules = [
      { events: ["card", "idle.reminder"], sources: [], to: ["onebot:1"], staff: false },
      { events: ["card"], sources: ["page"], to: [], staff: true },
      { events: ["idle.reminder", "platform.maintenance"], sources: [], to: ["onebot:2"], staff: false },
    ];
    sqlite.query("INSERT INTO device_capabilities VALUES ('s','b','bot',?),('s','c','bot','{\"tokenId\":\"u\"}'),('s','m','power',?)")
      .run(JSON.stringify({ tokenId: "t", announceRules: rules }), JSON.stringify({ announceRules: [{ events: ["idle.reminder"] }] }));
    run(sqlite, "0052_maintenance_announcements.sql");
    const config = (id: string) => JSON.parse((sqlite.query("SELECT config_json FROM device_capabilities WHERE device_id = ?").get(id) as { config_json: string }).config_json);
    expect(config("b").announceRules.map((rule: { events: string[] }) => rule.events)).toEqual([
      ["card", "idle.reminder", "platform.maintenance"], ["card"], ["idle.reminder", "platform.maintenance"],
    ]);
    expect(config("b").announceRules[0]).toMatchObject({ to: ["onebot:1"], staff: false });
    expect(config("c")).toEqual({ tokenId: "u" });
    expect(config("m").announceRules[0].events).toEqual(["idle.reminder"]);
    sqlite.close();
  });
});

describe("migration 0053: rules and words name what they announce by the event itself", () => {
  it("maps every old name onto the events it meant, and moves a shop's own words with them", () => {
    const sqlite = new Database(":memory:");
    sqlite.run(`CREATE TABLE device_capabilities(shop_id TEXT, device_id TEXT, capability TEXT, config_json TEXT, PRIMARY KEY (shop_id, device_id, capability))`);
    const config = {
      tokenId: "t",
      replyTemplates: { "announce.card.message": "刷了 {device}", "announce.request.refused.message": "{action} 不行", "wallet.success": "ok" },
      announceRules: [
        { events: ["card", "request.coin", "request.refused", "idle.reminder", "power.on", "start", "request.power.idle_off"], sources: ["page"], to: ["onebot:1"], staff: true },
        { events: [], sources: [], to: [], staff: false },
      ],
    };
    sqlite.query("INSERT INTO device_capabilities VALUES ('s','b','bot',?),('s','c','bot','{\"tokenId\":\"u\"}')").run(JSON.stringify(config));
    run(sqlite, "0053_announcement_keys.sql");
    const read = (id: string) => JSON.parse((sqlite.query("SELECT config_json FROM device_capabilities WHERE device_id = ?").get(id) as { config_json: string }).config_json);
    const migrated = read("b");
    expect(migrated.announceRules[0]).toEqual({
      events: [
        "card.consumed", "coin.sent", "coin.auto.sent",
        "power.on.refused", "power.off.refused", "power.keep.refused", "aime.scan.refused", "coin.refused",
        "idle.reminder", "power.changed.on", "occupancy.started", "power.off.idle.sent",
      ],
      sources: ["page"], to: ["onebot:1"], staff: true,
    });
    expect(migrated.announceRules[1].events).toEqual([]);
    // A refusal's words named the action, which each refusal now says itself.
    expect(migrated.replyTemplates).toEqual({ "announce.card.consumed.message": "刷了 {device}", "wallet.success": "ok" });
    expect(read("c")).toEqual({ tokenId: "u" });
    sqlite.close();
  });
});

describe("migration 0054: each rule becomes a group with a whole table, in the bot's words", () => {
  it("turns rules into groups, keeps their destinations and sources, and moves the announcement words into each", () => {
    const sqlite = new Database(":memory:");
    sqlite.run(`CREATE TABLE device_capabilities(shop_id TEXT, device_id TEXT, capability TEXT, config_json TEXT, PRIMARY KEY (shop_id, device_id, capability))`);
    const config = {
      tokenId: "t",
      replyTemplates: { "announce.card.consumed.message": "刷了 {device}", "wallet.success": "ok" },
      announceRules: [
        { events: ["card.consumed", "idle.reminder"], sources: ["page"], to: ["onebot:1"], staff: true },
        { events: ["checkout.settled"], sources: [], to: ["onebot:2"], staff: false },
      ],
    };
    sqlite.query("INSERT INTO device_capabilities VALUES ('s','b','bot',?),('s','c','bot','{\"tokenId\":\"u\"}'),('s','m','power','{}')").run(JSON.stringify(config));
    run(sqlite, "0054_announcement_groups.sql");
    const read = (id: string) => JSON.parse((sqlite.query("SELECT config_json FROM device_capabilities WHERE device_id = ?").get(id) as { config_json: string }).config_json);
    const words = { "announce.card.consumed.message": "刷了 {device}" };
    expect(read("b")).toEqual({
      tokenId: "t",
      replyTemplates: { "wallet.success": "ok" },
      announceGroups: [
        { id: "group-1", name: "播报组 1", to: ["onebot:1"], staff: true, templates: words,
          events: { "card.consumed": { on: true, sources: ["page"] }, "idle.reminder": { on: true, sources: ["page"] } } },
        { id: "group-2", name: "播报组 2", to: ["onebot:2"], staff: false, templates: words,
          events: { "checkout.settled": { on: true, sources: [] } } },
      ],
    });
    // A bot without rules announces nothing still, and keeps no announcement words.
    expect(read("c")).toEqual({ tokenId: "u", announceGroups: [], replyTemplates: {} });
    expect(read("m")).toEqual({});
    sqlite.close();
  });
});
