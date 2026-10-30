import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { splitD1MigrationStatements } from "@prism/storage-sql";
import { createApp } from "../src/app.js";
import { createD1DatabaseFromSqlite } from "../src/local-server.js";
import { clearShopDependenciesCache } from "../src/middleware/tenant.js";
import { sha256, sha256Hex } from "../src/crypto.js";
import { mintResourceTicket } from "../src/routes/platform/resource-ticket.js";
import type { Env } from "../src/bindings.js";

const NOW = new Date().toISOString();
const OWNER = "owner-token";

function plan(sqlite: Database, id: string, relations?: { requires?: string[] }) {
  sqlite.run(
    `INSERT INTO pricing_configs(shop_id,id,kind,name,enabled,status,provider_json,created_at,updated_at)
     VALUES ('shop',?,'time.priority',?,1,'active',?,?,?)`,
    [id, id, JSON.stringify({
      id, timeZone: "UTC",
      rules: [{ id: `${id}-rule`, label: "全天", priority: 0, timeRange: { start: "00:00", end: "00:00" },
        pricing: { unitMinutes: 60, unitPrice: 100, roundGraceMinutes: 0, priceCap: 100000 } }],
      ...(relations ? { relations: { requires: relations.requires ?? [], conflicts: [] } } : {}),
    }), NOW, NOW],
  );
}

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=OFF");
  const migrations = resolve(import.meta.dir, "../../../migrations");
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort())
    for (const sql of splitD1MigrationStatements(readFileSync(resolve(migrations, name), "utf8"))) sqlite.run(sql);
  sqlite.run("INSERT INTO users(id,role,created_at,updated_at) VALUES ('owner-user','user',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ('auth','owner-user',?,?)",
    [await sha256(OWNER), new Date(Date.now() + 86_400_000).toISOString()]);
  sqlite.run("INSERT INTO shops(id,public_id,name,latitude,longitude,radius_meters,created_by) VALUES ('shop','shop-code','Arcade',0,0,80,'owner-user')");
  sqlite.run("INSERT INTO shop_members(id,shop_id,user_id,role) VALUES ('m1','shop','owner-user','owner')");
  // The owner plays here too and bound their QQ identity, as staff do.
  sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','owner-player','店主','active',?)", [NOW]);
  sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop','owner-user','owner-player',?)", [NOW]);
  sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop','owner-player','onebot','10001',?)", [NOW]);
  sqlite.run("INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at) VALUES ('shop','owner-user','onebot','10001',?)", [NOW]);
  sqlite.run(`INSERT INTO shop_billing_settings(shop_id,billing_enabled,auto_register,identity_binding_required)
    VALUES ('shop',1,1,0)`);
  // Every resource without a group of its own bills through the default group.
  sqlite.run("INSERT INTO resource_groups(shop_id,id,name,enabled,default_pricing_config_id,created_at,updated_at) VALUES ('shop','default','默认资源组',1,'base',?,?)", [NOW, NOW]);
  sqlite.run("INSERT INTO asset_definitions(shop_id,type,code,name,stackable,status) VALUES ('shop','currency','paid','猫粮',1,'active')");
  plan(sqlite, "base");
  plan(sqlite, "mahjong", { requires: ["base"] });
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted,aliases_json,capacity) VALUES ('table','table-pub','shop','A 桌','','[\"a\"]',2)");
  sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
    VALUES ('shop','table','mahjong',?,'{}',?,?)`, [JSON.stringify({ pricingConfigIds: ["mahjong"] }), NOW, NOW]);
  sqlite.run("INSERT INTO machines(id,public_id,shop_id,name,hinata_url_encrypted) VALUES ('door','door-pub','shop','大门','')");
  sqlite.run(`INSERT INTO device_capabilities(shop_id,device_id,capability,config_json,secret_json,created_at,updated_at)
    VALUES ('shop','door','door','{"lockId":7}','{}',?,?)`, [NOW, NOW]);

  const env = { DB: createD1DatabaseFromSqlite(sqlite), SESSION_SECRET: "session-secret", URL_ENCRYPTION_KEY: "unit-test-key" } as unknown as Env;
  const app = createApp();
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await app.fetch(new Request(`https://prism.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    const json = await response.json() as any;
    return { status: response.status, body: json?.data ?? json };
  };
  const bot = (token: string) => ({
    get: (path: string) => call("GET", `/api/v1/shops/shop-code/integration/${path}`, token),
    post: (path: string, body: unknown) => call("POST", `/api/v1/shops/shop-code/integration/${path}`, token, body),
  });
  const createBot = async (settings: Record<string, unknown> = {}) => {
    const created = await call("POST", "/api/v1/merchant/machines", OWNER, { shopId: "shop", name: "店铺 Bot", bot: settings });
    return { id: created.body.machine.id as string, token: created.body.botToken as string, machine: created.body.machine };
  };
  return { sqlite, env, call, bot, createBot };
}

describe("a bot is a resource", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("issues its token once and tells it its settings and what the shop knows", async () => {
    const { bot, createBot, call } = await fixture();
    const created = await createBot({ playerCommands: "readonly", announceChannelIds: ["group-1"] });
    expect(created.token).toMatch(/^prism_integration_/);
    expect(created.machine.bot).toMatchObject({ playerCommands: "readonly" });
    expect(created.machine.bot).not.toHaveProperty("tokenId");
    const listed = await call("GET", "/api/v1/merchant/machines?shopId=shop", OWNER);
    expect(JSON.stringify(listed.body)).not.toContain(created.token);

    const config = await bot(created.token).get("bot");
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({
      bot: { id: created.id, name: "店铺 Bot" },
      settings: { playerCommands: "readonly", announceChannelIds: ["group-1"], staffCommands: true },
      currencyName: "猫粮",
      staff: [{ provider: "onebot", subject: "10001" }],
      // The only door, found without being chosen.
      door: { id: "door", name: "大门" },
      mahjongTables: [{ id: "table", name: "A 桌", aliases: ["a"], capacity: 2 }],
    });
  });

  it("refreshes connected bots when a bound account becomes a shop owner or leaves", async () => {
    const { sqlite, env, bot, createBot } = await fixture();
    const client = bot((await createBot()).token);
    sqlite.run("INSERT INTO users(id,role) VALUES ('new-owner','user')");
    sqlite.run("INSERT INTO players(shop_id,id,display_name,status,created_at) VALUES ('shop','new-player','新负责人','active',?)", [NOW]);
    sqlite.run("INSERT INTO shop_player_accounts(shop_id,user_id,player_id,verified_at) VALUES ('shop','new-owner','new-player',?)", [NOW]);
    sqlite.run("INSERT INTO player_identities(shop_id,player_id,provider,subject,created_at) VALUES ('shop','new-player','onebot','20002',?)", [NOW]);
    sqlite.run("INSERT INTO shop_platform_bindings(shop_id,user_id,provider,subject,verified_at) VALUES ('shop','new-owner','onebot','20002',?)", [NOW]);
    const staff = async () => (await client.get("bot")).body.staff;
    expect(await staff()).not.toContainEqual({ provider: "onebot", subject: "20002" });
    let refreshes = 0;
    env.SHOP_HUB = { getByName: (id: string) => {
      expect(id).toBe("shop");
      return { botsChanged: async () => { refreshes++; } };
    } } as unknown as Env["SHOP_HUB"];
    const pending: Promise<unknown>[] = [];
    const app = createApp();
    const change = async (method: string, path: string, body?: unknown) => {
      const response = await app.fetch(new Request(`https://prism.test/api/v1/merchant/${path}`, {
        method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env, { waitUntil: (task) => { pending.push(task); }, passThroughOnException() {}, props: {} });
      await Promise.all(pending.splice(0));
      return response;
    };
    expect((await change("POST", "shop-members", { shopId: "shop", user: "new-owner", role: "owner" })).status).toBe(200);
    expect(refreshes).toBe(1);
    expect(await staff()).toContainEqual({ provider: "onebot", subject: "20002" });
    const member = sqlite.query("SELECT id FROM shop_members WHERE shop_id='shop' AND user_id='new-owner'").get() as { id: string };
    expect((await change("DELETE", `shop-members/${member.id}`)).status).toBe(200);
    expect(refreshes).toBe(2);
    expect(await staff()).not.toContainEqual({ provider: "onebot", subject: "20002" });
    expect((await change("DELETE", "shop-members/m1")).status).toBe(409);
    expect(refreshes).toBe(2);
  });

  it("gives a token issued before bots were resources a resource of its own", async () => {
    const { sqlite, bot, call } = await fixture();
    sqlite.run("INSERT INTO api_tokens(shop_id,id,label,role,token_prefix,token_hash,status,created_at) VALUES ('shop','old','旧 Bot','integration','prism_integration',?,'active',?)",
      [await sha256Hex("legacy-token"), NOW]);
    expect((await bot("legacy-token").get("bot")).body.bot.name).toBe("旧 Bot");
    const listed = await call("GET", "/api/v1/merchant/machines?shopId=shop", OWNER);
    expect(listed.body.machines.some((machine: { name: string; bot: unknown }) => machine.name === "旧 Bot" && machine.bot)).toBe(true);
  });

  it("reports the current credential's first use for the setup guide, and resets it on rotation or revocation", async () => {
    const { sqlite, bot, call, createBot } = await fixture();
    const created = await createBot();
    expect(created.machine).toMatchObject({ hasBotToken: true, botLastUsedAt: null });
    const listed = async () => (await call("GET", "/api/v1/merchant/machines?shopId=shop", OWNER)).body.machines
      .find((machine: { id: string }) => machine.id === created.id);
    expect((await bot(created.token).get("bot")).status).toBe(200);
    const firstUse = (await listed()).botLastUsedAt;
    expect(Number.isFinite(Date.parse(firstUse))).toBe(true);
    expect((await bot(created.token).get("bot")).status).toBe(200);
    expect((await listed()).botLastUsedAt).toBe(firstUse);
    const rotated = await call("PATCH", `/api/v1/merchant/machines/${created.id}`, OWNER, { rotateBotToken: true });
    expect(rotated.body.machine).toMatchObject({ hasBotToken: true, botLastUsedAt: null });
    expect((await bot(created.token).get("bot")).status).toBe(403);
    expect((await listed()).botLastUsedAt).toBeNull();
    await bot(rotated.body.botToken).get("bot");
    sqlite.run("UPDATE api_tokens SET status='revoked' WHERE shop_id='shop' AND status='active'");
    expect(await listed()).toMatchObject({ hasBotToken: false, botLastUsedAt: null });
  });

  it("reports each bot's live connection independently, and keeps unavailable status unknown", async () => {
    const { env, call, createBot } = await fixture();
    const first = await createBot();
    const second = await createBot();
    let online = [first.id];
    env.SHOP_HUB = { getByName: (id: string) => {
      expect(id).toBe("shop");
      return { connectedBots: async () => online };
    } } as unknown as Env["SHOP_HUB"];
    const list = async () => (await call("GET", "/api/v1/merchant/machines?shopId=shop", OWNER)).body.machines as { id: string; botOnline: boolean | null }[];
    let machines = await list();
    expect(machines.find((m) => m.id === first.id)?.botOnline).toBe(true);
    expect(machines.find((m) => m.id === second.id)?.botOnline).toBe(false);
    online = [];
    expect((await list()).find((m) => m.id === first.id)?.botOnline).toBe(false);
    delete env.SHOP_HUB;
    machines = await list();
    expect(machines.filter((m) => [first.id, second.id].includes(m.id)).every((m) => m.botOnline === null)).toBe(true);
  });

  it("revokes the token when the bot is removed or its token rotated", async () => {
    const { bot, createBot, call } = await fixture();
    const created = await createBot();
    const rotated = await call("PATCH", `/api/v1/merchant/machines/${created.id}`, OWNER, { rotateBotToken: true });
    expect(rotated.body.botToken).toMatch(/^prism_integration_/);
    expect((await bot(created.token).get("bot")).status).toBe(403);
    expect((await bot(rotated.body.botToken).get("bot")).status).toBe(200);

    await call("PATCH", `/api/v1/merchant/machines/${created.id}`, OWNER, { bot: null });
    expect((await bot(rotated.body.botToken).get("bot")).status).toBe(403);
  });

  it("is not something players scan", async () => {
    const { env, call, createBot } = await fixture();
    const created = await createBot();
    const { ticket } = await mintResourceTicket(env.SESSION_SECRET, "shop-code", created.machine.publicId);
    const scanned = await call("GET", `/api/v1/devices/session/bootstrap?ticket=${encodeURIComponent(ticket)}`, OWNER);
    expect(scanned.status).toBe(404);
  });
});

describe("the bot seats players through the platform", () => {
  beforeEach(() => clearShopDependenciesCache());
  afterEach(() => clearShopDependenciesCache());

  it("seats and unseats by table name or alias, opening the table when it fills", async () => {
    const { bot, createBot } = await fixture();
    const client = bot((await createBot()).token);
    const p1 = { identity: { provider: "onebot", subject: "1" }, autoRegister: true, displayName: "一号" };
    const p2 = { identity: { provider: "onebot", subject: "2" }, autoRegister: true, displayName: "二号" };

    // Waiting at a table that is not full yet, a player can still leave.
    expect((await client.post("players/by-identity/mahjong", { ...p1, table: "a", action: "join" })).status).toBe(200);
    expect((await client.post("players/by-identity/mahjong", { ...p1, table: "a", action: "leave" })).status).toBe(200);
    expect((await client.post("players/by-identity/mahjong", { ...p1, table: "a", action: "join" })).status).toBe(200);
    const joined = await client.post("players/by-identity/mahjong", { ...p2, table: "A 桌", action: "join" });
    expect(joined.body.mahjong.seats.map((seat: { name: string; playing: boolean }) => [seat.name, seat.playing]))
      .toEqual([["一号", true], ["二号", true]]);

    const sessions = (await client.get("sessions/active")).body.sessions as { playerDisplayName: string; pricingConfigId: string; planName: string }[];
    expect(sessions.filter((s) => s.playerDisplayName === "一号").map((s) => s.planName).sort()).toEqual(["base", "mahjong"]);

    await client.post("players/by-identity/mahjong", { ...p1, table: "a", action: "leave" });
    const tables = (await client.get("mahjong-tables")).body.tables;
    expect(tables).toEqual([{ id: "table", name: "A 桌", aliases: ["a"], capacity: 2, seats: [{ playerId: expect.any(String), name: "二号", playing: true }] }]);
    expect((await client.post("players/by-identity/mahjong", { ...p1, table: "nope", action: "join" })).status).toBe(404);
    const notSeated = await client.post("players/by-identity/mahjong", { ...p1, table: "a", action: "leave" });
    expect(notSeated.status).toBe(409);
    expect(notSeated.body.error.code).toBe("MAHJONG_NOT_SEATED");
  });

  it("says whether a player was already in that plan, and which plan it is", async () => {
    const { bot, createBot } = await fixture();
    const client = bot((await createBot()).token);
    const player = { identity: { provider: "onebot", subject: "1" }, autoRegister: true, entry: true };
    expect((await client.post("players/by-identity/session/start", player)).body).toMatchObject({ created: true, planName: "base" });
    expect((await client.post("players/by-identity/session/start", player)).body).toMatchObject({ created: false, planName: "base" });
  });

  it("rejects obsolete named-plan starts without changing billing", async () => {
    const { bot, createBot } = await fixture();
    const client = bot((await createBot()).token);
    const player = { identity: { provider: "onebot", subject: "1" }, autoRegister: true };
    await client.post("players/by-identity/session/start", player);
    const table = await client.post("players/by-identity/session/start", { ...player, pricingConfigIds: ["mahjong"], label: "A 桌" });
    expect(table.status).toBe(400);
    expect(table.body.error.code).toBe("VALIDATION_FAILED");
    expect((await client.get("sessions/active")).body.sessions.map((s: any) => s.planName)).toEqual(["base"]);
  });
});
